import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { NocMonitor, type NocSnapshot } from "../src/noc-monitor.js";
import { loadTelegramAgentConfig } from "../src/telegram-config.js";

const config = {
  expectedIdentity: "Ro-Test", recipient: 123, interfaces: ["ISP-1"],
  routeTables: ["main"], intervalMs: 30_000, consecutiveSamples: 3,
};
const api = { key: "API router", state: "ok", detail: "RouterOS 6.49.23" } as const;
const link = { key: "Ethernet ISP-1", state: "ok", detail: "link-ok" } as const;
const noLink = { ...link, state: "fault", detail: "no-link" } as const;
const unavailable = { ...api, state: "unknown", detail: "pembacaan API gagal" } as const;

test("NOC debounces incidents and recovery, retries alerts, and skips recovery on missing data", async () => {
  const sent: string[] = [];
  let reads: NocSnapshot["readings"] = [];
  let diagnoseCalls = 0;
  let failNotify = true;
  const monitor = new NocMonitor({
    config,
    read: async () => ({ observedAt: "2026-01-01T00:00:00Z", readings: reads }),
    notify: async (message) => {
      if (failNotify) throw new Error("unavailable");
      sent.push(message);
    },
    diagnose: async () => {
      diagnoseCalls++;
      return "Periksa kabel.";
    },
  });
  const { signal } = new AbortController();
  const sample = async (...readings: NocSnapshot["readings"]) => {
    reads = readings;
    await monitor.poll(signal);
  };
  await sample(api, noLink);
  await sample(api, noLink);
  await sample(api, link);
  await sample(api, noLink);
  await sample(api, noLink);
  assert.equal(sent.length, 0);
  await assert.rejects(sample(api, noLink), /unavailable/);
  assert.equal(diagnoseCalls, 0);
  failNotify = false;
  await sample(api, noLink);
  await setImmediate();
  await sample(api, noLink);
  assert.equal(diagnoseCalls, 1);
  assert.equal(sent.length, 2);
  assert.match(sent[0]!, /\*\*Gangguan\*\*\n• Ethernet ISP-1/);
  assert.match(sent[1]!, /Periksa kabel/);

  await sample(api, link);
  await sample(api, link);
  await sample(unavailable);
  await sample(api, link);
  await sample(api, link);
  assert.equal(sent.length, 2);
  await sample(api, link);
  assert.equal(sent.length, 3);
  assert.match(sent[2]!, /\*\*Pulih\*\*\n• Ethernet ISP-1/);
});

test("NOC verifies the recipient is allowlisted before loading any monitor configuration", (context) => {
  const env = {
    TELEGRAM_BOT_TOKEN: `12345:${"x".repeat(30)}`,
    TELEGRAM_ALLOWED_USER_IDS: "123",
    NOC_ENABLED: "true",
    NOC_TELEGRAM_USER_ID: "456",
    NOC_EXPECTED_ROUTER: "Ro-Test",
    NOC_ETHERNET_INTERFACES: "ISP-1",
    NOC_IPV4_ROUTE_TABLES: "main",
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  context.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  assert.throws(loadTelegramAgentConfig, /NOC_TELEGRAM_USER_ID/);
  process.env.NOC_TELEGRAM_USER_ID = "123";
  assert.equal(loadTelegramAgentConfig().noc?.recipient, 123);
});

test("NOC delivers both the outage and recovery after Telegram connectivity returns", async () => {
  const sent: string[] = [];
  let readings: NocSnapshot["readings"] = [unavailable];
  let reachable = false;
  let diagnoses = 0;
  const monitor = new NocMonitor({
    config: { ...config, consecutiveSamples: 2 },
    read: async () => ({ observedAt: new Date().toISOString(), readings }),
    notify: async (message) => {
      if (!reachable) throw new Error("Telegram unavailable");
      sent.push(message);
    },
    diagnose: async () => {
      diagnoses++;
      return "Unexpected diagnosis";
    },
  });
  const { signal } = new AbortController();
  await monitor.poll(signal);
  await assert.rejects(monitor.poll(signal), /Telegram unavailable/);
  readings = [api, link];
  await assert.rejects(monitor.poll(signal), /Telegram unavailable/);
  await assert.rejects(monitor.poll(signal), /Telegram unavailable/);
  reachable = true;
  await monitor.poll(signal);
  await monitor.poll(signal);

  assert.equal(sent.length, 2);
  assert.match(sent[0]!, /\*\*Belum terukur\*\*\n• API router/);
  assert.match(sent[1]!, /\*\*Pulih\*\*\n• API router/);
  assert.equal(diagnoses, 0);
});

test("NOC sends a log alert immediately without starting an AI diagnosis", async () => {
  const sent: string[] = [];
  let diagnoses = 0;
  const monitor = new NocMonitor({
    config: { ...config, logEnabled: true },
    read: async () => ({
      observedAt: "2026-01-01T00:00:00Z", readings: [api, link],
      logAlerts: ["Ethernet ISP-1 mencatat link putus"],
    }),
    notify: async (message) => { sent.push(message); },
    diagnose: async () => { diagnoses++; return "Unexpected diagnosis"; },
  });
  await monitor.poll(new AbortController().signal);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /Kejadian log[\s\S]*Ethernet ISP-1 mencatat link putus/);
  assert.equal(diagnoses, 0);
});
