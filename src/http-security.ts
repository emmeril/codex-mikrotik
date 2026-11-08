import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { validateWriteOperation } from "./tools.js";

type Attributes = Record<string, string | number | boolean>;

export interface HttpConfig {
  host: string;
  port: number;
  adminPort: number;
  bearerToken: string;
  approvalToken: string | undefined;
  allowedOrigins: Set<string>;
  writeEnabled: boolean;
  writePrefixes: string[];
  approvalTtlMs: number;
}

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error("Invalid HTTP MCP numeric configuration");
  }
  return parsed;
}

function enabled(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  throw new Error("Expected true or false in HTTP MCP configuration");
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value || value.trim() !== value || value.length < 32) {
    throw new Error(name + " must be a random secret of at least 32 characters");
  }
  return value;
}

const unsafePaths = [
  "/certificate", "/file", "/interface/wireguard", "/ip/ipsec",
  "/ip/service", "/ppp/secret", "/radius", "/system", "/user",
];

function withinPath(commandPath: string, prefix: string): boolean {
  return commandPath === prefix || commandPath.startsWith(prefix + "/");
}

export function loadHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const host = env.MCP_HTTP_HOST || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("HTTP MCP must bind to loopback. Use a private tunnel or authenticated HTTPS reverse proxy.");
  }

  const port = positiveInteger(env.MCP_HTTP_PORT, 8765, 65535);
  const adminPort = positiveInteger(env.MCP_APPROVAL_PORT, 8766, 65535);
  if (port === adminPort) throw new Error("MCP and approval ports must differ");
  const bearerToken = requireSecret(env.MCP_HTTP_BEARER_TOKEN, "MCP_HTTP_BEARER_TOKEN");
  const writeEnabled = enabled(env.MCP_HTTP_WRITE_ENABLED);
  const approvalToken = writeEnabled
    ? requireSecret(env.MCP_APPROVAL_TOKEN, "MCP_APPROVAL_TOKEN")
    : undefined;
  if (approvalToken === bearerToken) {
    throw new Error("MCP_APPROVAL_TOKEN must differ from MCP_HTTP_BEARER_TOKEN");
  }
  if (writeEnabled && !enabled(env.MIKROTIK_WRITE_ENABLED)) {
    throw new Error("Enable MIKROTIK_WRITE_ENABLED separately for approved HTTP writes");
  }

  const writePrefixes = (env.MCP_HTTP_WRITE_PREFIXES || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  for (const prefix of writePrefixes) {
    if (!/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(prefix) ||
        unsafePaths.some((unsafe) => withinPath(prefix, unsafe) || withinPath(unsafe, prefix))) {
      throw new Error("Unsafe MCP_HTTP_WRITE_PREFIXES entry: " + prefix);
    }
  }
  if (writeEnabled && writePrefixes.length === 0) {
    throw new Error("MCP_HTTP_WRITE_PREFIXES must explicitly allow narrow RouterOS menus");
  }

  const allowedOrigins = new Set<string>();
  for (const candidate of (env.MCP_HTTP_ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean)) {
    const url = new URL(candidate);
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== candidate) {
      throw new Error("MCP_HTTP_ALLOWED_ORIGINS requires complete origins, never wildcards");
    }
    allowedOrigins.add(url.origin);
  }

  return {
    host, port, adminPort, bearerToken, approvalToken, allowedOrigins,
    writeEnabled, writePrefixes,
    approvalTtlMs: positiveInteger(env.MCP_APPROVAL_TTL_SECONDS, 300, 600) * 1000,
  };
}

export function safeBearer(header: string | undefined, expected: string): boolean {
  if (!header || header.length > 1024) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match?.[1]) return false;
  const actualHash = createHash("sha256").update(match[1]).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function validOrigin(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  return origin === undefined || allowed.has(origin);
}

export function validateHttpWrite(
  command: string,
  attributes: Attributes,
  config: Pick<HttpConfig, "writeEnabled" | "writePrefixes">,
): void {
  if (!config.writeEnabled) throw new Error("HTTP MCP writes are disabled");
  validateWriteOperation(command, attributes);
  const menu = command.slice(0, command.lastIndexOf("/"));
  if (unsafePaths.some((prefix) => withinPath(menu, prefix))) {
    throw new Error("This RouterOS menu is blocked from HTTP MCP writes");
  }
  if (!config.writePrefixes.some((prefix) => withinPath(menu, prefix))) {
    throw new Error("RouterOS menu is not included in MCP_HTTP_WRITE_PREFIXES");
  }
  if (Object.keys(attributes).some((key) => /^(password|secret|private-key|token|passphrase)$/i.test(key))) {
    throw new Error("Secret attributes cannot be changed via HTTP MCP");
  }
}

export interface ChangePreview {
  id: string;
  command: string;
  attributes: Attributes;
  fingerprint: string;
  expiresAt: number;
  approved: boolean;
}

interface PendingChange extends ChangePreview {
  principal: string;
}

export class HttpApprovalStore {
  private readonly pending = new Map<string, PendingChange>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(principal: string, command: string, attributes: Attributes): ChangePreview {
    this.cleanup();
    if (this.pending.size >= 100) throw new Error("Too many pending changes");
    const canonical = Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b)));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ command, attributes: canonical }))
      .digest("hex");
    const change: PendingChange = {
      id: randomUUID(), principal, command, attributes: canonical,
      fingerprint, expiresAt: this.now() + this.ttlMs, approved: false,
    };
    this.pending.set(change.id, change);
    return this.publicView(change);
  }

  inspect(id: string): ChangePreview | undefined {
    const change = this.pending.get(id);
    if (!change || this.expired(change)) return undefined;
    return this.publicView(change);
  }

  approve(id: string, fingerprint: string): boolean {
    const change = this.pending.get(id);
    if (!change || this.expired(change) || change.approved) return false;
    if (!safeCompare(fingerprint, change.fingerprint)) return false;
    change.approved = true;
    return true;
  }

  take(id: string, principal: string): { ok: true; change: ChangePreview } | { ok: false; reason: string } {
    const change = this.pending.get(id);
    if (!change) return { ok: false, reason: "not_found" };
    if (this.expired(change)) return { ok: false, reason: "expired" };
    if (change.principal !== principal) return { ok: false, reason: "forbidden" };
    if (!change.approved) return { ok: false, reason: "not_approved" };
    this.pending.delete(id);
    return { ok: true, change: this.publicView(change) };
  }

  private publicView(change: PendingChange): ChangePreview {
    return {
      id: change.id, command: change.command, attributes: { ...change.attributes },
      fingerprint: change.fingerprint, expiresAt: change.expiresAt,
      approved: change.approved,
    };
  }

  private expired(change: PendingChange): boolean {
    if (this.now() < change.expiresAt) return false;
    this.pending.delete(change.id);
    return true;
  }

  private cleanup(): void {
    for (const change of this.pending.values()) this.expired(change);
  }
}

function safeCompare(actual: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function principalForToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
