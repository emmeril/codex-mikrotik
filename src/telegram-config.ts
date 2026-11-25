export interface NocConfig {
  recipient: number;
  expectedIdentity: string;
  interfaces: string[];
  routeTables: string[];
  intervalMs: number;
  consecutiveSamples: number;
  logEnabled?: boolean;
  wanSessionNames?: string[];
}

export interface TelegramAgentConfig {
  botToken: string;
  allowedUserIds: Set<string>;
  privateOnly: boolean;
  pollTimeoutSeconds: number;
  pendingChangeTtlMs: number;
  codexBinary: string;
  codexTransport: "app-server" | "exec";
  codexModel?: string;
  codexReasoningEffort?: string;
  codexServiceTier?: string;
  codexTimeoutMs: number;
  noc?: NocConfig;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} wajib diisi`);
  return value;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} harus berupa true atau false`);
}

function integerValue(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} harus bilangan bulat ${minimum}-${maximum}`);
  }
  return value;
}

function nocNames(name: string, raw: string): string[] {
  const names = raw.split(",").map((value) => value.trim());
  if (names.length > 8 || new Set(names).size !== names.length
    || names.some((value) => !value || value.length > 100 || value === "all" || /[\x00-\x1f\x7f]/.test(value))) {
    throw new Error(`${name} harus berisi 1-8 nama spesifik yang berbeda`);
  }
  return names;
}

function loadNocConfig(allowedUserIds: ReadonlySet<string>): NocConfig | undefined {
  if (!booleanValue("NOC_ENABLED", false)) return undefined;
  const userId = required("NOC_TELEGRAM_USER_ID");
  const recipient = Number(userId);
  if (!/^[1-9]\d*$/.test(userId) || !Number.isSafeInteger(recipient) || !allowedUserIds.has(userId)) {
    throw new Error("NOC_TELEGRAM_USER_ID harus berupa ID pengguna dalam TELEGRAM_ALLOWED_USER_IDS");
  }
  const expectedIdentity = required("NOC_EXPECTED_ROUTER");
  if (expectedIdentity.length > 100 || /[\x00-\x1f\x7f]/.test(expectedIdentity)) {
    throw new Error("NOC_EXPECTED_ROUTER harus berupa nama router yang valid");
  }
  const wanSessionNames = process.env.NOC_WAN_SESSION_NAMES?.trim();
  return {
    recipient,
    expectedIdentity,
    interfaces: nocNames("NOC_ETHERNET_INTERFACES", required("NOC_ETHERNET_INTERFACES")),
    routeTables: nocNames("NOC_IPV4_ROUTE_TABLES", process.env.NOC_IPV4_ROUTE_TABLES?.trim() || "main"),
    intervalMs: integerValue("NOC_INTERVAL_SECONDS", 30, 15, 600) * 1_000,
    consecutiveSamples: integerValue("NOC_CONSECUTIVE_SAMPLES", 3, 2, 10),
    logEnabled: booleanValue("NOC_LOG_ENABLED", true),
    ...(wanSessionNames ? { wanSessionNames: nocNames("NOC_WAN_SESSION_NAMES", wanSessionNames) } : {}),
  };
}

export function loadTelegramAgentConfig(): TelegramAgentConfig {
  const botToken = required("TELEGRAM_BOT_TOKEN");
  if (!/^\d{5,20}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    throw new Error("TELEGRAM_BOT_TOKEN tidak memiliki format token bot yang valid");
  }

  const allowedUserIds = new Set(
    required("TELEGRAM_ALLOWED_USER_IDS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const id of allowedUserIds) {
    if (!/^\d+$/.test(id)) {
      throw new Error("TELEGRAM_ALLOWED_USER_IDS harus berisi ID numerik dipisahkan koma");
    }
  }

  const codexTransport = process.env.CODEX_TRANSPORT?.trim() || "app-server";
  if (codexTransport !== "app-server" && codexTransport !== "exec") {
    throw new Error("CODEX_TRANSPORT harus berupa app-server atau exec");
  }

  const noc = loadNocConfig(allowedUserIds);
  return {
    botToken,
    allowedUserIds,
    privateOnly: booleanValue("TELEGRAM_PRIVATE_ONLY", true),
    pollTimeoutSeconds: integerValue("TELEGRAM_POLL_TIMEOUT_SECONDS", 30, 1, 50),
    pendingChangeTtlMs: integerValue(
      "TELEGRAM_CONFIRM_TTL_SECONDS",
      300,
      30,
      3600,
    ) * 1_000,
    codexBinary: process.env.CODEX_BIN?.trim() || "codex",
    codexTransport,
    ...(process.env.CODEX_MODEL?.trim()
      ? { codexModel: process.env.CODEX_MODEL.trim() }
      : {}),
    ...(process.env.CODEX_REASONING_EFFORT?.trim()
      ? { codexReasoningEffort: process.env.CODEX_REASONING_EFFORT.trim() }
      : {}),
    ...(process.env.CODEX_SERVICE_TIER?.trim()
      ? { codexServiceTier: process.env.CODEX_SERVICE_TIER.trim() }
      : {}),
    codexTimeoutMs: integerValue("CODEX_TIMEOUT_SECONDS", 300, 30, 1_800) * 1_000,
    ...(noc ? { noc } : {}),
  };
}
