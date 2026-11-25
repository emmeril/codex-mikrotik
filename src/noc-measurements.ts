import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import type { RouterOsConfig } from "./config.js";
import { monitorTraffic } from "./diagnostics.js";
import type { NocInventory } from "./noc-inventory.js";
import type { NocMetric, NocReading, NocSnapshot } from "./noc-monitor.js";
import type { NocConfig } from "./telegram-config.js";
import { withClient } from "./tools.js";

type Part = { readings: NocReading[]; metrics: NocMetric[] };
type Asset = NocInventory["assets"][number];

export async function measureNoc(
  snapshot: NocSnapshot, router: RouterOsConfig, noc: NocConfig, inventory: NocInventory,
): Promise<NocSnapshot> {
  const metrics = [...(snapshot.metrics ?? [])];
  const readings = [...snapshot.readings];
  const routerOk = readings.some(({ key, state }) => key === "API router" && state === "ok");
  if (routerOk) {
    for (const [key, limit] of [["CPU MikroTik", inventory.cpuAlertPct], ["RAM MikroTik", inventory.ramAlertPct]] as const) {
      const value = metrics.find((x) => x.key === key)?.value;
      readings.push(value === undefined
        ? { key, state: "unknown", detail: "nilai belum tersedia" }
        : { key, state: value >= limit ? "fault" : "ok", detail: `${value.toFixed(1)}%, ambang ${limit}%` });
    }
  }
  const parts = await Promise.all([
    routerOk ? measureLinks(router, noc, inventory) : undefined,
    routerOk ? measureQueues(router, inventory) : undefined,
    measureAssets(inventory.assets),
    measureBackups(inventory.backups),
  ]);
  for (const part of parts) {
    if (!part) continue;
    readings.push(...part.readings);
    metrics.push(...part.metrics);
  }
  return { ...snapshot, observedAt: new Date().toISOString(), metrics, readings };
}

async function measureLinks(router: RouterOsConfig, noc: NocConfig, inventory: NocInventory): Promise<Part> {
  const readings: NocReading[] = [];
  const metrics: NocMetric[] = [];
  for (const name of noc.interfaces) {
    const key = `Trafik ${name}`;
    try {
      const sample = (await monitorTraffic([name], router)).interfaces[0] as Record<string, string> | undefined;
      const rx = bps(sample?.["rx-bits-per-second"]);
      const tx = bps(sample?.["tx-bits-per-second"]);
      const cap = inventory.links.find((link) => link.interface === name);
      const utilization: number[] = [];
      for (const [direction, rate, capacity] of [["RX", rx, cap?.rxMbps], ["TX", tx, cap?.txMbps]] as const) {
        if (rate === undefined) continue;
        metrics.push({ key: `${name} ${direction}`, value: rate / 1e6, unit: "Mbps" });
        if (capacity !== undefined) {
          const percent = rate / 1e6 / capacity * 100;
          utilization.push(percent);
          metrics.push({ key: `${name} utilisasi ${direction}`, value: percent, unit: "%", capacity: true });
        }
      }
      const detail = `RX ${rx === undefined ? "?" : (rx / 1e6).toFixed(2)}, TX ${tx === undefined ? "?" : (tx / 1e6).toFixed(2)} Mbps`;
      readings.push({ key, state: utilization.some((value) => value >= 80) ? "fault"
        : rx === undefined || tx === undefined ? "unknown" : "ok",
      detail: `${detail}${utilization.length ? `, utilisasi tertinggi ${Math.max(...utilization).toFixed(1)}%` : ""}` });
    } catch {
      readings.push({ key, state: "unknown", detail: "monitor trafik gagal" });
    }
  }
  return { readings, metrics };
}

async function measureQueues(router: RouterOsConfig, inventory: NocInventory): Promise<Part> {
  const readings: NocReading[] = [];
  const metrics: NocMetric[] = [];
  for (const queue of inventory.queues) {
    const key = `Queue ${queue.label}`;
    try {
      const [row] = await withClient((client) => client.command("/queue/simple/print", {
        attributes: { stats: true }, queries: [`?name=${queue.name}`],
        proplist: ["name", "rate", "disabled"], limit: 1, replyBudget: { maxRows: 1, timeoutMs: 5_000 },
      }), router);
      if (!row || row.name !== queue.name || ["true", "yes"].includes(row.disabled ?? "")) {
        readings.push({ key, state: "unknown", detail: "queue tidak ditemukan atau nonaktif" });
        continue;
      }
      const [up, down] = row.rate?.split("/").map(bps) ?? [];
      if (up === undefined || down === undefined) {
        readings.push({ key, state: "unknown", detail: "laju queue belum tersedia" });
        continue;
      }
      metrics.push(
        { key: `${key} upload`, value: up / 1e6, unit: "Mbps" },
        { key: `${key} download`, value: down / 1e6, unit: "Mbps" },
      );
      readings.push({ key, state: "ok", detail: `upload ${(up / 1e6).toFixed(2)}, download ${(down / 1e6).toFixed(2)} Mbps` });
    } catch {
      readings.push({ key, state: "unknown", detail: "API statistik queue gagal" });
    }
  }
  return { readings, metrics };
}

async function measureAssets(assets: NocInventory["assets"]): Promise<Part> {
  const parts: Part[] = [];
  for (let index = 0; index < assets.length; index += 4) {
    parts.push(...await Promise.all(assets.slice(index, index + 4).map(probeAsset)));
  }
  return { readings: parts.flatMap((x) => x.readings), metrics: parts.flatMap((x) => x.metrics) };
}

async function probeAsset(asset: Asset): Promise<Part> {
  const key = `Perangkat ${asset.id}`;
  const prefix = `${asset.label} · ${asset.probe.kind.toUpperCase()} dari host NOC`;
  if (asset.probe.kind === "tcp") {
    const result = await tcpProbe(asset.probe.address, asset.probe.port);
    return {
      readings: [{ key, state: result.state, detail: `${prefix}: ${result.state === "ok" ? "port terjangkau" : result.state === "fault" ? "port tidak terjangkau" : "probe belum terukur"}` }],
      metrics: result.ms === undefined ? [] : [{ key: `${key} TCP connect`, value: result.ms, unit: "ms" }],
    };
  }
  const result = await icmpProbe(asset.probe.address);
  if (!result) return { readings: [{ key, state: "unknown", detail: `${prefix}: hasil probe belum tersedia` }], metrics: [] };
  const fault = result.loss >= asset.probe.maxLossPct || (result.avg !== undefined
    && asset.probe.maxRttMs !== undefined && result.avg >= asset.probe.maxRttMs);
  const metrics: NocMetric[] = [{ key: `${key} packet loss`, value: result.loss, unit: "%" }];
  if (result.avg !== undefined) metrics.push({ key: `${key} RTT`, value: result.avg, unit: "ms" });
  if (result.jitter !== undefined) metrics.push({ key: `${key} deviasi RTT`, value: result.jitter, unit: "ms" });
  return {
    readings: [{ key, state: fault ? "fault" : "ok",
      detail: `${prefix}: loss ${result.loss}%${result.avg === undefined ? "" : `, RTT rata-rata ${result.avg} ms`}` }],
    metrics,
  };
}

export function parseIcmpProbe(stdout: string): { loss: number; avg?: number; jitter?: number } | undefined {
  const summary = /(?:^|\n)5 packets transmitted, (\d+) (?:packets )?received, .*?([\d.]+)% packet loss/m.exec(stdout);
  if (!summary) return undefined;
  const received = Number(summary[1]);
  const loss = Number(summary[2]);
  if (!Number.isFinite(loss) || received > 5 || loss < 0 || loss > 100) return undefined;
  const times = /(?:rtt|round-trip) min\/avg\/max\/(?:mdev|stddev) = [\d.]+\/([\d.]+)\/[\d.]+\/([\d.]+) ms/.exec(stdout);
  const avg = Number(times?.[1]);
  const jitter = Number(times?.[2]);
  return { loss, ...(Number.isFinite(avg) && received > 0 ? { avg } : {}),
    ...(Number.isFinite(jitter) && received >= 2 ? { jitter } : {}) };
}

function icmpProbe(address: string): Promise<ReturnType<typeof parseIcmpProbe>> {
  return new Promise((resolve) => {
    execFile("ping", ["-n", "-c", "5", "-i", "0.2", "-W", "1", "-w", "3", address], {
      timeout: 4_000, maxBuffer: 16 * 1024, env: { PATH: process.env.PATH, LC_ALL: "C" },
    }, (error, stdout) => resolve(!error || error.code === 1 ? parseIcmpProbe(stdout) : undefined));
  });
}

function tcpProbe(address: string, port: number): Promise<{ state: NocReading["state"]; ms?: number }> {
  const start = performance.now();
  return new Promise((resolve) => {
    const socket = createConnection({ host: address, port });
    socket.setTimeout(1_500);
    const done = (state: NocReading["state"], ms?: number) => {
      socket.destroy();
      resolve({ state, ...(ms !== undefined ? { ms } : {}) });
    };
    socket.once("connect", () => done("ok", performance.now() - start));
    socket.once("timeout", () => done("fault"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(
      ["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"].includes(error.code ?? "") ? "fault" : "unknown",
    ));
  });
}

async function measureBackups(backups: NocInventory["backups"]): Promise<Part> {
  const readings = await Promise.all(backups.map(async (backup): Promise<NocReading> => {
    const key = `Backup ${backup.id}`;
    try {
      const info = await stat(backup.path);
      const hours = (Date.now() - info.mtimeMs) / 3_600_000;
      if (!info.isFile() || info.size === 0) return { key, state: "fault", detail: `${backup.label}: file kosong atau bukan file biasa` };
      if (hours < 0) return { key, state: "unknown", detail: `${backup.label}: waktu file berada di masa depan` };
      return { key, state: hours > backup.maxAgeHours ? "fault" : "ok",
        detail: `${backup.label}: umur ${hours.toFixed(1)} jam, batas ${backup.maxAgeHours} jam` };
    } catch (error) {
      return { key, state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "fault" : "unknown",
        detail: `${backup.label}: metadata file tidak tersedia` };
    }
  }));
  return { readings, metrics: [] };
}

function bps(raw: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([kmg]?)(?:bps)?$/i.exec(raw ?? "");
  if (!match) return undefined;
  const scale = { "": 1, k: 1e3, m: 1e6, g: 1e9 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  const rate = Number(match[1]) * scale;
  return Number.isFinite(rate) ? rate : undefined;
}
