import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import test, { type TestContext } from "node:test";
import { monitorEthernet, monitorTraffic, pingRouter } from "../src/diagnostics.js";
import type { RouterOsConfig } from "../src/config.js";
import { encodeSentence, SentenceReader } from "../src/protocol.js";
import { runReadCommand } from "../src/tools.js";

interface Exchange {
  command: string;
  includes?: string[];
  reply: string[][];
}

test("negotiated 1Gbps wins over configured 100Mbps on an auto-negotiated link", async (context) => {
  const config = await router(context, [
    settings(),
    { command: "/interface/ethernet/monitor", includes: ["=numbers=*1", "=once=yes"], reply: [
      ["!re", "=status=link-ok", "=rate=1Gbps", "=full-duplex=true", "=auto-negotiation=done"],
    ] },
  ]);
  const result = await monitorEthernet(["ISP-1"], config);
  assert.equal(result.interfaces[0]?.configured_speed, "100Mbps");
  assert.equal(result.interfaces[0]?.negotiated_rate, "1Gbps");
  assert.equal(result.interfaces[0]?.negotiated_full_duplex, true);
  assert.equal(result.interfaces[0]?.auto_negotiation_enabled, true);
  assert.ok(result.interfaces[0]?.observed_at);
});

test("missing rate and duplex stay unknown instead of falling back to configuration", async (context) => {
  const config = await router(context, [
    settings(),
    { command: "/interface/ethernet/monitor", reply: [["!re", "=status=link-ok"]] },
  ]);
  const result = await monitorEthernet(["ISP-1"], config);
  assert.equal(result.interfaces[0]?.negotiated_rate, null);
  assert.equal(result.interfaces[0]?.negotiated_full_duplex, null);
});

test("down link does not expose a stale rate as a current negotiated rate", async (context) => {
  const config = await router(context, [
    settings(),
    { command: "/interface/ethernet/monitor", reply: [["!re", "=status=no-link", "=rate=1Gbps", "=full-duplex=true"]] },
  ]);
  const result = await monitorEthernet(["ISP-1"], config);
  assert.equal(result.interfaces[0]?.link_status, "no-link");
  assert.equal(result.interfaces[0]?.negotiated_rate, null);
  assert.equal(result.interfaces[0]?.negotiated_full_duplex, null);
});

test("monitor permission failure is reported instead of substituting configured speed", async (context) => {
  const config = await router(context, [
    settings(),
    { command: "/interface/ethernet/monitor", reply: [["!trap", "=message=not enough permissions"]] },
  ]);
  await assert.rejects(monitorEthernet(["ISP-1"], config), /not enough permissions/);
});

test("unknown Ethernet interface is rejected before monitoring anything", async (context) => {
  const config = await router(context, [{ command: "/interface/ethernet/print", reply: [] }]);
  await assert.rejects(monitorEthernet(["typo"], config), /tidak ditemukan/);
});

test("traffic uses a bounded live sample and preserves bit units and direction", async (context) => {
  const config = await router(context, [
    { command: "/interface/print", includes: ["?name=ISP-1"], reply: [["!re", "=.id=*1", "=name=ISP-1"]] },
    { command: "/interface/monitor-traffic", includes: ["=interface=*1", "=once=yes"], reply: [
      ["!re", "=name=ISP-1", "=rx-bits-per-second=9000000", "=tx-bits-per-second=1000000"],
    ] },
  ]);
  const result = await monitorTraffic(["ISP-1"], config);
  assert.equal(result.interfaces[0]?.["rx-bits-per-second"], "9000000");
  assert.equal(result.interfaces[0]?.["tx-bits-per-second"], "1000000");
  assert.match(result.units, /bits\/s/);
});

test("ping preserves explicit source, interface and table without unbounded packets", async (context) => {
  const config = await router(context, [{
    command: "/ping",
    includes: ["=count=3", "=interval=200ms", "=address=192.0.2.1", "=src-address=192.0.2.2", "=interface=ISP-1", "=routing-table=wan1"],
    reply: [["!re", "=seq=0", "=host=192.0.2.1", "=time=1ms"]],
  }]);
  const result = await pingRouter({ address: "192.0.2.1", count: 3, src_address: "192.0.2.2", interface: "ISP-1", routing_table: "wan1" }, config);
  assert.equal(result.rows[0]?.host, "192.0.2.1");
  assert.equal(result.probe.count, 3);
});

test("unsupported ping parameters fail instead of silently probing the main table", async (context) => {
  const config = await router(context, [{ command: "/ping", reply: [["!trap", "=message=unknown parameter routing-table"]] }]);
  await assert.rejects(pingRouter({ address: "192.0.2.1", routing_table: "wan1" }, config), /unknown parameter/);
});

test("diagnostics reject broad selectors, duplicates and excessive probes before connecting", async () => {
  for (const names of [[], ["all"], ["ISP-1,ISP-2"], ["ISP-1", "ISP-1"], ["ISP-1\n"]]) {
    await assert.rejects(monitorEthernet(names));
    await assert.rejects(monitorTraffic(names));
  }
  for (const count of [0, 11, 1.5, Infinity]) {
    await assert.rejects(pingRouter({ address: "192.0.2.1", count }), /count/);
  }
  await assert.rejects(pingRouter({ address: "192.0.2.1; /system/reboot" }), /IP atau hostname/);
  await assert.rejects(pingRouter({ address: "192.0.2.1", src_address: "192.0.2.2/24" }), /src_address/);
});

test("generic read query still rejects monitors, writes, sensitive paths and streaming or file attributes", async (context) => {
  const env = { MIKROTIK_HOST: "127.0.0.1", MIKROTIK_USERNAME: "test", MIKROTIK_PASSWORD: "test", MIKROTIK_SENSITIVE_READ_ENABLED: "false" };
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  context.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const command of ["/interface/ethernet/monitor", "/system/reboot", "/ip/address/set", "/system/script/print", "/ppp/secret/print", "//ppp/secret/print"]) {
    await assert.rejects(runReadCommand(command, {}));
  }
  for (const key of ["file", "follow", "follow-only", "interval"]) {
    await assert.rejects(runReadCommand("/interface/print", { attributes: { [key]: "sample" } }), /tidak diizinkan/);
  }
});

function settings(): Exchange {
  return { command: "/interface/ethernet/print", includes: ["?name=ISP-1"], reply: [
    ["!re", "=.id=*1", "=name=ISP-1", "=speed=100Mbps", "=auto-negotiation=true", "=full-duplex=false"],
  ] };
}

async function router(context: TestContext, exchanges: Exchange[]): Promise<RouterOsConfig> {
  const failures: unknown[] = [];
  const sockets = new Set<Socket>();
  let completed = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    void (async () => {
      const reader = new SentenceReader(socket);
      assert.equal((await reader.readSentence())[0], "/login");
      socket.write(encodeSentence(["!done"]));
      for (const exchange of exchanges) {
        const words = await reader.readSentence();
        assert.equal(words[0], exchange.command);
        for (const expected of exchange.includes ?? []) assert.ok(words.includes(expected), expected);
        for (const sentence of exchange.reply) socket.write(encodeSentence(sentence));
        socket.write(encodeSentence(["!done"]));
        completed++;
      }
    })().catch((error: unknown) => { failures.push(error); socket.destroy(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
    assert.deepEqual(failures, []);
    assert.equal(completed, exchanges.length);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return {
    host: "127.0.0.1", port: address.port, username: "test", password: "test",
    tls: false, tlsRejectUnauthorized: true, connectTimeoutMs: 1_000,
    commandTimeoutMs: 1_000, maxRows: 100, writeEnabled: false, sensitiveReadEnabled: false,
  };
}
