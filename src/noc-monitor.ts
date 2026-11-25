import { setTimeout as delay } from "node:timers/promises";
import { RouterOsError, type RouterOsRecord } from "./client.js";
import type { RouterOsConfig } from "./config.js";
import { monitorEthernet } from "./diagnostics.js";
import type { NocConfig } from "./telegram-config.js";
import { withClient } from "./tools.js";

interface NocReading {
  key: string;
  state: "ok" | "fault" | "unknown";
  detail: string;
}

export interface NocSnapshot {
  observedAt: string;
  readings: NocReading[];
}

export async function readNocSnapshot(router: RouterOsConfig, noc: NocConfig): Promise<NocSnapshot> {
  const readings: NocReading[] = [];
  const addRouterReading = (state: NocReading["state"], detail: string) => {
    readings.push({ key: "API router", state, detail });
  };
  try {
    const version = await withClient(async (client) => {
      const [identity] = await client.command("/system/identity/print", { proplist: ["name"], limit: 1 });
      if (identity?.name !== noc.expectedIdentity) return null;
      const [resource] = await client.command("/system/resource/print", {
        proplist: ["version"], limit: 1,
      });
      return resource?.version?.match(/^[67]\.\d+(?:\.\d+)*/)?.[0];
    }, router);
    if (version === null) {
      addRouterReading("unknown", "Identitas belum cocok dengan target. Link dan rute tidak diperiksa.");
    } else if (!version) {
      addRouterReading("unknown", "Versi RouterOS 6/7 belum terverifikasi. Link dan rute tidak diperiksa.");
    } else {
      addRouterReading("ok", `Identitas cocok, RouterOS ${version}`);
      for (const name of noc.interfaces) readings.push(await readEthernet(router, name));
      readings.push(...await readDefaultRoutes(router, version, noc.routeTables));
    }
  } catch (error) {
    addRouterReading("unknown", readFailure(error));
  }
  return { observedAt: new Date().toISOString(), readings };
}

async function readEthernet(router: RouterOsConfig, name: string): Promise<NocReading> {
  const key = `Ethernet ${name}`;
  try {
    const sample = (await monitorEthernet([name], router)).interfaces[0];
    if (sample?.link_status === "no-link") return { key, state: "fault", detail: "monitor melaporkan no-link" };
    if (sample?.link_status !== "link-ok") return { key, state: "unknown", detail: "status link belum tersedia" };
    const rate = sample.negotiated_rate?.match(/^\d+(?:\.\d+)?[MG]bps$/)?.[0];
    return { key, state: "ok", detail: rate ? `link-ok, ${rate}` : "link-ok, rate belum tersedia" };
  } catch (error) {
    return { key, state: "unknown", detail: readFailure(error) };
  }
}

async function readDefaultRoutes(
  router: RouterOsConfig,
  version: string,
  tables: string[],
): Promise<NocReading[]> {
  const tableField = version.startsWith("6.") ? "routing-mark" : "routing-table";
  const limit = Math.min(64, router.maxRows);
  try {
    const rows = await withClient((client) => client.command("/ip/route/print", {
      queries: ["?dst-address=0.0.0.0/0"],
      proplist: ["dst-address", tableField, "active", "gateway", "type", "blackhole", "unreachable", "prohibit"],
      limit,
    }), router);
    return tables.map((table) => {
      const key = `Default IPv4 ${table}`;
      const selected = rows.filter((row) => row["dst-address"] === "0.0.0.0/0"
        && (row[tableField] || (tableField === "routing-mark" ? "main" : "")) === table);
      const active = selected.filter((row) => flag(row, "active"));
      if (active.some((row) => row.gateway && !isDiscardRoute(row))) {
        return { key, state: "ok", detail: "ada rute default aktif dengan gateway" };
      }
      if (rows.length >= limit || rows.some((row) => row["dst-address"] !== "0.0.0.0/0"
        || (tableField === "routing-table" && !row[tableField]))
        || selected.some((row) => !["true", "yes", "false", "no"].includes(row.active ?? ""))
        || active.some((row) => !isDiscardRoute(row))) {
        return { key, state: "unknown", detail: "data flag, gateway, atau tabel rute belum lengkap" };
      }
      return {
        key, state: "fault", detail: active.length
          ? "rute default aktif mengarah ke discard"
          : selected.length ? "tidak ada rute default aktif" : "tidak ada entri rute default pada pembacaan",
      };
    });
  } catch (error) {
    return tables.map((table) => ({ key: `Default IPv4 ${table}`, state: "unknown", detail: readFailure(error) }));
  }
}

function flag(row: RouterOsRecord, name: string): boolean {
  return row[name] === "true" || row[name] === "yes";
}

function isDiscardRoute(row: RouterOsRecord): boolean {
  return ["blackhole", "unreachable", "prohibit"].some((name) => row.type === name || flag(row, name));
}

function readFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof RouterOsError) {
    if (/permission|not allowed/i.test(message)) return "izin pembacaan ditolak";
    if (/unknown parameter|no such command|unknown command/i.test(message)) return "menu atau parameter tidak didukung";
    return "RouterOS menolak pembacaan";
  }
  if (/Interface Ethernet tidak ditemukan/.test(message)) return "tidak ada baris untuk nama Ethernet ini";
  if (/Monitor tidak mengembalikan status/.test(message)) return "monitor tidak mengembalikan baris";
  return "koneksi atau pembacaan API gagal";
}

interface CheckProgress {
  latest: NocReading["state"];
  consecutive: number;
  confirmed: NocReading["state"];
}

export class NocMonitor {
  readonly #checks = new Map<string, CheckProgress>();
  readonly #outbox: NocSnapshot[] = [];
  #droppedNotifications = 0;
  #latest: NocSnapshot | undefined;
  #analysis: Promise<void> | undefined;

  constructor(private readonly options: {
    config: NocConfig;
    read: () => Promise<NocSnapshot>;
    notify: (message: string) => Promise<unknown>;
    diagnose: (snapshot: NocSnapshot) => Promise<string>;
  }) {}

  status(): string {
    const latest = this.#latest;
    return latest
      ? this.#format("NOC · Pembacaan terakhir", latest)
      : "NOC belum selesai mengambil sampel pertama.";
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.poll(signal);
      } catch {
        console.error("NOC gagal membaca sampel atau mengirim notifikasi. Akan dicoba lagi.");
      }
      await delay(this.options.config.intervalMs, undefined, { signal }).catch(() => undefined);
    }
  }

  async poll(signal: AbortSignal): Promise<void> {
    const snapshot = await this.options.read();
    if (signal.aborted) return;
    this.#latest = snapshot;
    const seen = new Set(snapshot.readings.map(({ key }) => key));
    for (const [key, progress] of this.#checks) {
      if (!seen.has(key)) progress.consecutive = 0;
    }
    const changes = snapshot.readings.filter(({ key, state }) => this.#record(key, state));
    if (changes.length) {
      if (this.#outbox.length === 32) {
        this.#outbox.shift();
        this.#droppedNotifications++;
      }
      this.#outbox.push({ ...snapshot, readings: changes });
    }
    const pending = this.#outbox[0];
    if (!pending) return;
    const missed = this.#droppedNotifications
      ? `\n${this.#droppedNotifications} notifikasi terdahulu terlewat karena antrean penuh.` : "";
    await this.options.notify(this.#format("NOC · Perubahan status", pending) + missed);
    this.#outbox.shift();
    this.#droppedNotifications = 0;
    const faults = pending.readings.filter(({ key, state }) => state !== "ok"
      && snapshot.readings.some((reading) => reading.key === key && reading.state === state));
    if (signal.aborted || !faults.length || this.#analysis) return;
    if (!snapshot.readings.some(({ key, state }) => key === "API router" && state === "ok")) return;

    this.#analysis = this.options.diagnose({ ...pending, readings: faults })
      .then(async (analysis) => {
        const stillRelevant = faults.some(({ key, state }) =>
          this.#latest?.readings.some((reading) => reading.key === key && reading.state === state));
        if (!signal.aborted && stillRelevant) {
          await this.options.notify(`NOC · Diagnosis awal untuk sampel ${pending.observedAt}\n\n${analysis}\n\nUntuk meminta perubahan, balas lewat chat bot. Rencana akan ditampilkan untuk ditinjau.`);
        }
      })
      .catch(() => console.error("NOC gagal menyelesaikan atau mengirim diagnosis lanjutan."))
      .finally(() => { this.#analysis = undefined; });
  }

  #record(key: string, state: NocReading["state"]): boolean {
    const progress = this.#checks.get(key) ?? { latest: state, consecutive: 0, confirmed: "ok" };
    const threshold = this.options.config.consecutiveSamples;
    progress.consecutive = progress.latest === state ? Math.min(threshold, progress.consecutive + 1) : 1;
    progress.latest = state;
    this.#checks.set(key, progress);
    if (progress.confirmed === state || progress.consecutive < threshold) return false;
    progress.confirmed = state;
    return true;
  }

  #format(title: string, snapshot: NocSnapshot): string {
    const labels = { ok: "OK", fault: "TERGANGGU", unknown: "BELUM TERUKUR" };
    return [
      `${title} · ${this.options.config.expectedIdentity}`,
      snapshot.observedAt,
      ...snapshot.readings.map(({ key, state, detail }) => `• ${key} [${labels[state]}] ${detail}`),
      "Cakupan pengukuran: API, link Ethernet dan rute default IPv4. Internet dari sisi klien belum diuji.",
    ].join("\n");
  }
}
