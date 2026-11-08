import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpApprovalStore, loadHttpConfig, safeBearer, validOrigin, validateHttpWrite,
} from "../src/http-security.js";

const baseEnv = {
  MCP_HTTP_BEARER_TOKEN: "a".repeat(64),
  MCP_APPROVAL_TOKEN: "b".repeat(64),
  MIKROTIK_WRITE_ENABLED: "true",
  MCP_HTTP_WRITE_ENABLED: "true",
  MCP_HTTP_WRITE_PREFIXES: "/ip/firewall/address-list",
};

test("HTTP MCP binds only to loopback and refuses missing or weak secrets", () => {
  assert.throws(() => loadHttpConfig({ MCP_HTTP_BEARER_TOKEN: "short" }), /32 characters/);
  assert.throws(() => loadHttpConfig({ ...baseEnv, MCP_HTTP_HOST: "0.0.0.0" }), /loopback/);
  assert.throws(() => loadHttpConfig({ ...baseEnv, MCP_APPROVAL_TOKEN: "a".repeat(64) }), /must differ/);
  assert.throws(() => loadHttpConfig({ ...baseEnv, MIKROTIK_WRITE_ENABLED: "false" }), /MIKROTIK_WRITE_ENABLED/);
  assert.throws(() => loadHttpConfig({ ...baseEnv, MCP_HTTP_WRITE_PREFIXES: "" }), /WRITE_PREFIXES/);
  assert.equal(loadHttpConfig({ MCP_HTTP_BEARER_TOKEN: "a".repeat(64) }).writeEnabled, false);
});

test("origin and bearer validation fail closed", () => {
  assert.equal(safeBearer("Bearer " + "a".repeat(64), "a".repeat(64)), true);
  assert.equal(safeBearer("Bearer " + "b".repeat(64), "a".repeat(64)), false);
  assert.equal(safeBearer("Basic " + "a".repeat(64), "a".repeat(64)), false);
  assert.equal(safeBearer(undefined, "a".repeat(64)), false);
  assert.equal(validOrigin(undefined, new Set()), true);
  assert.equal(validOrigin("https://evil.example", new Set()), false);
  assert.equal(validOrigin("https://trusted.example", new Set(["https://trusted.example"])), true);
});

test("HTTP MCP write scope rejects unsafe paths and unapproved menus", () => {
  const config = loadHttpConfig(baseEnv);
  assert.doesNotThrow(() => validateHttpWrite(
    "/ip/firewall/address-list/add", { list: "blocked", address: "192.0.2.10" }, config,
  ));
  assert.throws(() => validateHttpWrite(
    "/ip/firewall/filter/remove", { ".id": "*1" }, config,
  ), /not included/);
  assert.throws(() => validateHttpWrite(
    "/system/reboot", {}, config,
  ), /tidak diizinkan/);
  assert.throws(() => validateHttpWrite(
    "/ip/firewall/address-list/add", { password: "p" }, config,
  ), /Secret attributes/);
  assert.throws(() => loadHttpConfig({
    ...baseEnv, MCP_HTTP_WRITE_PREFIXES: "/system",
  }), /Unsafe/);
});

test("preview requires administrator approval of the exact fingerprint", () => {
  let now = 1000;
  const store = new HttpApprovalStore(5000, () => now);
  const a = store.create("tenant-a", "/ip/address/add", { address: "192.0.2.5/24" });
  assert.equal(store.take(a.id, "tenant-a").ok, false);
  assert.equal(store.approve(a.id, "0".repeat(64)), false);
  assert.equal(store.approve(a.id, a.fingerprint), true);
  assert.equal(store.approve(a.id, a.fingerprint), false);
  assert.deepEqual(store.take(a.id, "tenant-b"), { ok: false, reason: "forbidden" });
  assert.equal(store.take(a.id, "tenant-a").ok, true);
  assert.deepEqual(store.take(a.id, "tenant-a"), { ok: false, reason: "not_found" });
  const b = store.create("tenant-a", "/ip/address/add", { address: "192.0.2.6/24" });
  assert.notEqual(a.fingerprint, b.fingerprint);
  now = 6000;
  assert.equal(store.approve(b.id, b.fingerprint), false);
  assert.deepEqual(store.take(b.id, "tenant-a"), { ok: false, reason: "not_found" });
});

test("HTTP server authenticates requests without requiring a RouterOS connection", async (context) => {
  const { startHttpServers } = await import("../src/http-server.js");
  const config = loadHttpConfig({ MCP_HTTP_BEARER_TOKEN: "x".repeat(64) });
  const { mcp } = startHttpServers(config);
  await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
  context.after(() => mcp.close());
  const address = mcp.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const url = "http://127.0.0.1:" + address.port;
  const unauthorized = await fetch(url + "/mcp", { method: "POST" });
  assert.equal(unauthorized.status, 401);
  const forbiddenOrigin = await fetch(url + "/mcp", {
    method: "POST", headers: { Origin: "https://evil.example" },
  });
  assert.equal(forbiddenOrigin.status, 403);
  const get = await fetch(url + "/mcp", {
    headers: { Authorization: "Bearer " + "x".repeat(64) },
  });
  assert.equal(get.status, 405);
  const initialized = await fetch(url + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + "x".repeat(64),
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0.0" },
      },
    }),
  });
  assert.equal(initialized.status, 200);
  const result = await initialized.json() as { result?: { serverInfo?: { name?: string } } };
  assert.equal(result.result?.serverInfo?.name, "codex-mikrotik");
});
