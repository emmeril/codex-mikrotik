import assert from "node:assert/strict";
import test from "node:test";
import type { CommandOptions, RouterOsRecord } from "../src/client.js";
import { NocLogWatcher } from "../src/noc-logs.js";

function row(id: number, topics: string, message: string): RouterOsRecord {
  return { ".id": `*${id.toString(16)}`, topics, message };
}

class MemoryLog {
  rows: RouterOsRecord[] = [];
  capacity = "100";
  detailQueries: string[][] = [];

  async command(command: string, options: CommandOptions = {}): Promise<RouterOsRecord[]> {
    if (command === "/system/logging/action/print") {
      return [{ "memory-lines": this.capacity, "memory-stop-on-full": "false" }];
    }
    assert.equal(command, "/log/print");
    assert.equal(options.queries?.[0], "?buffer=memory");
    if (!options.proplist?.includes("message")) {
      return this.rows.map(({ message: _message, ...metadata }) => metadata);
    }
    const queries = options.queries ?? [];
    this.detailQueries.push(queries);
    return this.rows.filter((entry) => queries.includes(`?topics=${entry.topics}`));
  }
}

test("log watcher seeds history, matches WAN signals, and keeps account data out of alerts", async () => {
  const log = new MemoryLog();
  const watcher = new NocLogWatcher({
    interfaces: ["ISP-1", "ISP-2"], wanSessionNames: ["pppoe-out1"], maxRows: 100,
  });
  const old = row(1, "interface,info", "ISP-1 link down");
  log.rows = [old];
  assert.deepEqual((await watcher.sample(log, "1d")).alerts, []);
  assert.equal(log.detailQueries.length, 0);

  log.rows = [
    row(6, "dhcp,warning", "dhcp-client on ISP-2 lost IP address 192.0.2.1"),
    row(5, "pppoe,ppp,info", "pppoe-out1: disconnected"),
    row(4, "interface,info", "LAN-1 link down"),
    old,
    row(3, "hotspot,error,debug", "login failure for user example-customer"),
    row(2, "interface,info", "ISP-1 link down"),
    row(7, "system,info,account", "user example-admin logged in"),
  ];
  const { alerts } = await watcher.sample(log, "1d1m");
  assert.equal(alerts.length, 3);
  assert.ok(alerts.some((line) => line.includes("Ethernet ISP-1")));
  assert.ok(alerts.some((line) => line.includes("DHCP client di ISP-2")));
  assert.ok(alerts.some((line) => line.includes("Sesi WAN pppoe-out1")));
  assert.doesNotMatch(alerts.join("\n"), /192\.0\.2\.1|example-|LAN-1/);
  assert.ok(!log.detailQueries.flat().some((query) => /hotspot|system,info,account/.test(query)));
  log.rows.reverse();
  assert.deepEqual((await watcher.sample(log, "1d2m")).alerts, []);
});

test("log watcher groups repeated link events and counts router login failures across samples", async () => {
  let now = 0;
  const log = new MemoryLog();
  const watcher = new NocLogWatcher({ interfaces: ["ISP-1"], maxRows: 100, now: () => now });
  await watcher.sample(log, "1d");
  const failLogin = (id: number) => row(id, "system,error,critical", "login failure for user sample from 192.0.2.1");
  log.rows.push(row(1, "interface,info", "ISP-1 link down"), failLogin(2), failLogin(3));
  assert.deepEqual((await watcher.sample(log, "1d10s")).alerts, ["Ethernet ISP-1 mencatat link putus"]);
  now = 30_000;
  log.rows.push(row(4, "interface,info", "ISP-1 link down"), row(5, "interface,info", "ISP-1 link down"),
    failLogin(6), failLogin(7), failLogin(8));
  assert.deepEqual((await watcher.sample(log, "1d40s")).alerts, ["5 kegagalan login router baru terbaca dalam 5 menit"]);
  now = 300_000;
  assert.deepEqual((await watcher.sample(log, "1d5m")).alerts, ["Ethernet ISP-1 mencatat link putus (2 kejadian)"]);
});

test("log watcher reports continuity loss and handles reused IDs after a router reboot", async () => {
  const log = new MemoryLog();
  const watcher = new NocLogWatcher({ interfaces: ["ISP-1"], maxRows: 100 });
  log.rows = [row(1, "system,error,critical", "router rebooted")];
  assert.deepEqual((await watcher.sample(log, "2d")).alerts, []);
  const reboot = await watcher.sample(log, "10s");
  assert.ok(reboot.alerts.some((line) => line.includes("Cakupan log terputus")));
  assert.ok(reboot.alerts.some((line) => line.includes("router reboot")));
  assert.deepEqual((await watcher.sample(log, "40s")).alerts, []);

  log.capacity = "101";
  await assert.rejects(watcher.sample(log, "1m"), /Kapasitas buffer/);
});

test("firewall burst alerts count only registered prefixes and omit packet details", async () => {
  const log = new MemoryLog();
  const watcher = new NocLogWatcher({ interfaces: ["ISP-1"], maxRows: 100, firewallLogPrefixes: ["NOC-DROP"] });
  await watcher.sample(log, "1d");
  log.rows = Array.from({ length: 20 }, (_, i) => row(i + 1, "firewall,info", "NOC-DROP: private payload"));
  log.rows.push(row(21, "firewall,info", "NOC-DROP-OTHER: unrelated"));
  const { alerts } = await watcher.sample(log, "1d1m");
  assert.deepEqual(alerts, ["20 entri firewall dengan prefix NOC-DROP baru terbaca dalam 5 menit"]);
});
