import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { RouterOsConfig } from "../src/config.js";
import { loadNocInventory } from "../src/noc-inventory.js";
import { measureNoc, parseIcmpProbe } from "../src/noc-measurements.js";
import { NocMonitor } from "../src/noc-monitor.js";
import { NocOperations } from "../src/noc-operations.js";
import { formatTelegramText } from "../src/telegram-api.js";

async function temporary(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "noc-ops-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const base = {
  recipient: 1, expectedIdentity: "Ro-Test", interfaces: [], routeTables: [],
  intervalMs: 30_000, consecutiveSamples: 2,
};

test("incident keeps its ID after restart and closes only after confirmed recovery", async (t) => {
  const file = join(await temporary(t), "state.json");
  const inventory = loadNocInventory(undefined);
  const options = { file, routerIdentity: "Ro-Test", inventory, notify: async () => undefined };
  const at = new Date().toISOString();
  const fault = { key: "Ethernet ISP-1", state: "fault", detail: "monitor no-link" } as const;
  const ops = new NocOperations(options);
  await ops.observe({ observedAt: at, readings: [fault] }, [fault]);
  assert.match(await ops.command("/noc_ack", "noc-1") ?? "", /tetap terbuka/);
  assert.match(await ops.command("/noc_escalate", "NOC-1") ?? "", /monitor no-link/);
  assert.doesNotMatch(await ops.command("/noc_customer", "NOC-1") ?? "", /ISP-1|no-link/);

  const restored = new NocOperations(options);
  const notices: string[] = [];
  const recovered = { ...fault, state: "ok", detail: "link-ok" } as const;
  const monitor = new NocMonitor({
    config: base, previousStates: restored.activeStates(),
    incidentRef: (key, date) => restored.incidentRef(key, date),
    read: async () => ({ observedAt: new Date().toISOString(), readings: [recovered] }),
    notify: async (text) => { notices.push(text); },
    diagnose: async () => assert.fail("Recovery cannot trigger diagnosis"),
    observe: (snapshot, changes) => restored.observe(snapshot, changes),
  });
  const signal = new AbortController().signal;
  await monitor.poll(signal);
  assert.match(await restored.command("/noc_incidents", "") ?? "", /1 terbuka/);
  await monitor.poll(signal);
  assert.match(await new NocOperations(options).command("/noc_incidents", "") ?? "", /0 terbuka/);
  assert.match(notices[0] ?? "", /NOC-1.*link-ok/);
  assert.match(await restored.command("/noc_customer", "NOC-1") ?? "", /kembali normal/);
  assert.throws(() => new NocOperations({ ...options, routerIdentity: "Different" }), /router lain/);
});

test("daily report uses the previous WIB day and keeps its delivery marker across restart", async (t) => {
  const file = join(await temporary(t), "state.json");
  const notices: string[] = [];
  const options = {
    file, routerIdentity: "Ro-Test", inventory: loadNocInventory(undefined), dailyHour: 8,
    notify: async (text: string) => { notices.push(text); },
  };
  const ops = new NocOperations(options);
  for (const at of ["2026-11-25T09:00:00Z", "2026-11-25T09:05:00Z", "2026-11-25T16:00:00Z"]) {
    await ops.observe({ observedAt: at, readings: [], metrics: [
      { key: "ISP-1 utilisasi RX", unit: "%", value: 82, capacity: true },
    ] }, []);
  }
  await ops.observe({ observedAt: "2026-11-26T00:59:00Z", readings: [] }, []);
  assert.equal(notices.length, 0);
  await ops.observe({ observedAt: "2026-11-26T01:00:00Z", readings: [] }, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /2026-11-25 \(WIB\)/);
  assert.match(notices[0]!, /3\/3 sampel ≥80% kapasitas/);
  const formatted = formatTelegramText(notices[0]!);
  const headings = formatted.entities.map(({ offset, length }) => formatted.text.slice(offset, offset + length));
  assert.deepEqual(headings, ["Laporan NOC", "Ringkasan", "Trafik dan pemakaian kapasitas", "Kapasitas perlu ditinjau"]);
  assert.doesNotMatch(formatted.text, /\*\*/);
  await new NocOperations(options).observe({ observedAt: "2026-11-26T02:00:00Z", readings: [] }, []);
  assert.equal(notices.length, 1);
});

test("configured TCP and backup checks work while MikroTik API is unreachable", async (t) => {
  const folder = await temporary(t);
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const listening = server.address();
  assert.ok(listening && typeof listening !== "string");
  await writeFile(join(folder, "router.backup"), "private-test-content");
  const file = join(folder, "inventory.json");
  await writeFile(file, JSON.stringify({
    assets: [{ id: "local", label: "Local service", kind: "server", probe: { kind: "tcp", address: "127.0.0.1", port: listening.port } }],
    backups: [{ id: "archive", label: "Router archive", path: "router.backup", maxAgeHours: 24 }],
  }));
  const inventory = loadNocInventory(file);
  const sample = await measureNoc({
    observedAt: new Date().toISOString(), readings: [{ key: "API router", state: "unknown", detail: "tidak terbaca" }],
  }, {} as RouterOsConfig, base, inventory);
  assert.equal(sample.readings.find((x) => x.key === "Perangkat local")?.state, "ok");
  assert.equal(sample.readings.find((x) => x.key === "Backup archive")?.state, "ok");
  assert.doesNotMatch(JSON.stringify(sample), /private-test-content|127\.0\.0\.1|router\.backup/);
  assert.equal(sample.metrics?.[0]?.unit, "ms");
});

test("ICMP parsing keeps no replies separate from an unavailable probe", () => {
  assert.deepEqual(parseIcmpProbe("5 packets transmitted, 4 received, 20% packet loss, time 803ms\nrtt min/avg/max/mdev = 1.000/2.500/4.000/1.118 ms"), { loss: 20, avg: 2.5, jitter: 1.118 });
  assert.deepEqual(parseIcmpProbe("5 packets transmitted, 0 received, 100% packet loss, time 801ms"), { loss: 100 });
  assert.equal(parseIcmpProbe("ping: Operation not permitted"), undefined);
});
