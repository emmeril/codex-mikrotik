#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMikrotikMcpServer } from "./mcp-server.js";
import {
  HttpApprovalStore, loadHttpConfig, safeBearer, validOrigin,
  type HttpConfig,
} from "./http-security.js";

const MAX_BODY_BYTES = 128 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function deny(res: ServerResponse, status: number, error: string): void {
  if (status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="codex-mikrotik"');
  send(res, status, { error });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const length = Number(req.headers["content-length"]);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("Request too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function startHttpServers(config: HttpConfig = loadHttpConfig()) {
  const approvals = new HttpApprovalStore(config.approvalTtlMs);
  const mcp = createServer(async (req, res) => {
    try {
      if (!validOrigin(req.headers.origin, config.allowedOrigins)) {
        deny(res, 403, "Origin is not allowed");
        return;
      }
      const path = new URL(req.url || "/", "http://localhost").pathname;
      if (path === "/health" && req.method === "GET") {
        send(res, 200, { status: "ready" });
        return;
      }
      if (path !== "/mcp") {
        deny(res, 404, "Not found");
        return;
      }
      if (!safeBearer(req.headers.authorization, config.bearerToken)) {
        deny(res, 401, "Authentication required");
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        deny(res, 405, "Use POST for stateless Streamable HTTP MCP");
        return;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        deny(res, 415, "Expected application/json");
        return;
      }

      const body = await readJson(req);
      const server = createMikrotikMcpServer({ config, approvals });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.once("close", () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("HTTP MCP request failed:", error instanceof Error ? error.message : "unknown error");
      if (!res.headersSent) {
        deny(res, 400, "Invalid MCP request");
      } else {
        res.end();
      }
    }
  });

  const admin = createServer(async (req, res) => {
    try {
      if (!validOrigin(req.headers.origin, new Set())) {
        deny(res, 403, "Browser origins are not allowed on the admin endpoint");
        return;
      }
      if (!config.writeEnabled || !config.approvalToken) {
        deny(res, 404, "Approval service disabled");
        return;
      }
      if (!safeBearer(req.headers.authorization, config.approvalToken)) {
        deny(res, 401, "Administrator authentication required");
        return;
      }
      const path = new URL(req.url || "/", "http://localhost").pathname;
      const id = /^\/pending\/([a-f0-9-]{36})$/i.exec(path)?.[1];
      if (id && req.method === "GET") {
        const pending = approvals.inspect(id);
        if (!pending) {
          deny(res, 404, "No pending change");
          return;
        }
        send(res, 200, pending);
        return;
      }
      if (path === "/approve" && req.method === "POST") {
        const body = await readJson(req);
        if (!body || typeof body !== "object") {
          deny(res, 400, "Invalid approval");
          return;
        }
        const data = body as Record<string, unknown>;
        if (typeof data.id !== "string" || typeof data.fingerprint !== "string") {
          deny(res, 400, "Both id and fingerprint are required");
          return;
        }
        if (!approvals.approve(data.id, data.fingerprint)) {
          deny(res, 409, "Approval missing, expired, already used, or fingerprint mismatch");
          return;
        }
        send(res, 200, { approved: true, id: data.id });
        return;
      }
      deny(res, 404, "Not found");
    } catch {
      deny(res, 400, "Invalid administrator request");
    }
  });

  return { mcp, admin, approvals };
}

async function main(): Promise<void> {
  const config = loadHttpConfig();
  const { mcp, admin } = startHttpServers(config);
  await new Promise<void>((resolve, reject) => {
    mcp.once("error", reject);
    mcp.listen(config.port, config.host, resolve);
  });
  try {
    if (config.writeEnabled) {
      await new Promise<void>((resolve, reject) => {
        admin.once("error", reject);
        admin.listen(config.adminPort, "127.0.0.1", resolve);
      });
    }
  } catch (error) {
    mcp.close();
    throw error;
  }
  console.error("MikroTik HTTP MCP bound to " + config.host + ":" + config.port);
  if (config.writeEnabled) {
    console.error("Administrator approval endpoint bound to 127.0.0.1:" + config.adminPort);
  }
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
