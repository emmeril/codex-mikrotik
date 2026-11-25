import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as z from "zod/v4";
import type { NocInventory } from "./noc-inventory.js";
import type { NocReading, NocSnapshot } from "./noc-monitor.js";
import { telegramLiteral, telegramTime } from "./telegram-api.js";

const iso = z.iso.datetime();
const incidentSchema = z.object({
  id: z.string().regex(/^NOC-\d+$/), key: z.string().max(180), detail: z.string().max(500),
  state: z.enum(["fault", "unknown"]), openedAt: iso, updatedAt: iso,
  acknowledgedAt: iso.optional(), closedAt: iso.optional(),
});
const tallySchema = z.object({
  unit: z.enum(["%", "ms", "Mbps"]), count: z.number().int().positive(), sum: z.number(), peak: z.number(),
  over80: z.number().int().nonnegative(),
});
const daySchema = z.object({
  day: z.iso.date(), samples: z.number().int().nonnegative(),
  metrics: z.array(z.object({ key: z.string().max(180), tally: tallySchema })).max(160),
});
const stateSchema = z.object({
  version: z.literal(1),
  routerIdentity: z.string().min(1).max(100),
  nextId: z.number().int().positive(),
  incidents: z.array(incidentSchema).max(500),
  events: z.array(z.object({ at: iso, detail: z.string().max(500) })).max(240),
  days: z.array(daySchema).max(14),
  lastReportDay: z.iso.date().optional(),
});

type Incident = z.output<typeof incidentSchema>;
type OpsState = z.output<typeof stateSchema>;
type Tally = z.output<typeof tallySchema>;

const wib = (isoTime: string) => new Date(Date.parse(isoTime) + 7 * 3_600_000);
const dayOf = (isoTime: string) => wib(isoTime).toISOString().slice(0, 10);
const dayBefore = (day: string, offset = 1) => new Date(Date.parse(day) - offset * 86_400_000).toISOString().slice(0, 10);

export class NocOperations {
  readonly #file: string;
  readonly #state: OpsState;
  #queue: Promise<void> = Promise.resolve();
  #lastWrite = 0;
  #needsWrite = false;
  #urgentWrite = false;

  constructor(private readonly options: {
    file?: string;
    routerIdentity: string;
    inventory: NocInventory;
    dailyHour?: number;
    notify: (text: string) => Promise<void>;
  }) {
    this.#file = resolve(options.file ?? ".noc/state.json");
    this.#state = existsSync(this.#file)
      ? stateSchema.parse(JSON.parse(readFileSync(this.#file, "utf8")) as unknown)
      : { version: 1, routerIdentity: options.routerIdentity, nextId: 1, incidents: [], days: [], events: [] };
    if (this.#state.routerIdentity !== options.routerIdentity) throw new Error("Riwayat NOC berasal dari identitas router lain");
  }

  activeStates(): ReadonlyMap<string, NocReading["state"]> {
    return new Map(this.#state.incidents.filter((item) => !item.closedAt).map((item) => [item.key, item.state]));
  }

  incidentRef(key: string, at: string): string | undefined {
    return this.#state.incidents.find((item) => item.key === key && item.openedAt <= at
      && (!item.closedAt || at <= item.closedAt))?.id;
  }

  observe(snapshot: NocSnapshot, changes: NocReading[]): Promise<void> {
    return this.#serialize(async () => {
      if (changes.length || snapshot.logAlerts?.length) this.#urgentWrite = true;
      for (const change of changes) this.#record(change, snapshot.observedAt);
      for (const notice of snapshot.logAlerts ?? []) this.#event(snapshot.observedAt, notice);
      this.#sample(snapshot);
      const now = Date.parse(snapshot.observedAt);
      if (this.#urgentWrite || now - this.#lastWrite >= 5 * 60_000) await this.#save();
      await this.#dailyReport(snapshot.observedAt);
    });
  }

  recordChange(completed: number, ok: boolean): Promise<void> {
    return this.#serialize(async () => {
      this.#event(new Date().toISOString(), `Perubahan router disetujui · ${completed} operasi selesai · ${ok ? "selesai" : "gagal sebagian atau dihentikan"}`);
      await this.#save();
    });
  }

  flush(): Promise<void> {
    return this.#serialize(async () => { if (this.#needsWrite) await this.#save(); });
  }

  async command(command: string, argument: string): Promise<string | undefined> {
    const ref = argument.trim().toUpperCase();
    switch (command) {
      case "/noc_inventory": return this.#inventory();
      case "/noc_incidents": return this.#incidents();
      case "/noc_report": {
        if (ref && !["1", "7"].includes(ref)) return "Gunakan /noc_report atau /noc_report 7.";
        const today = dayOf(new Date().toISOString());
        return this.#report(ref === "7" ? dayBefore(today, 6) : today, today);
      }
      case "/noc_ack": return this.#ack(ref);
      case "/noc_escalate": return this.#draft(ref, false);
      case "/noc_customer": return this.#draft(ref, true);
      default: return undefined;
    }
  }

  #record(reading: NocReading, at: string): void {
    const open = this.#state.incidents.find((item) => item.key === reading.key && !item.closedAt);
    if (reading.state === "ok") {
      if (open) { open.closedAt = at; open.updatedAt = at; }
      return;
    }
    if (open) {
      open.state = reading.state;
      open.detail = reading.detail.slice(0, 500);
      open.updatedAt = at;
      return;
    }
    this.#state.incidents.push({
      id: `NOC-${this.#state.nextId++}`, key: reading.key, detail: reading.detail.slice(0, 500),
      state: reading.state, openedAt: at, updatedAt: at,
    });
    if (this.#state.incidents.length > 500) {
      const oldestClosed = this.#state.incidents.findIndex((item) => item.closedAt);
      if (oldestClosed >= 0) this.#state.incidents.splice(oldestClosed, 1);
    }
  }

  #event(at: string, detail: string): void {
    this.#state.events.push({ at, detail: detail.slice(0, 500) });
    if (this.#state.events.length > 240) this.#state.events.shift();
    this.#needsWrite = this.#urgentWrite = true;
  }

  #sample(snapshot: NocSnapshot): void {
    const date = dayOf(snapshot.observedAt);
    let day = this.#state.days.find((item) => item.day === date);
    if (!day) {
      day = { day: date, samples: 0, metrics: [] };
      this.#state.days.push(day);
      this.#state.days.sort((a, b) => a.day.localeCompare(b.day));
      this.#state.days = this.#state.days.slice(-14);
    }
    day.samples++;
    const metrics = new Map(day.metrics.map((item) => [item.key, item.tally]));
    for (const metric of snapshot.metrics ?? []) {
      if (!Number.isFinite(metric.value) || metric.value < 0) continue;
      let tally = metrics.get(metric.key);
      if (!tally) {
        if (metrics.size >= 160) continue;
        tally = { unit: metric.unit, count: 0, sum: 0, peak: 0, over80: 0 };
        metrics.set(metric.key, tally);
      }
      if (tally.unit !== metric.unit) continue;
      tally.count++;
      tally.sum += metric.value;
      tally.peak = Math.max(tally.peak, metric.value);
      if (metric.capacity && metric.value >= 80) tally.over80++;
    }
    day.metrics = [...metrics].map(([key, tally]) => ({ key, tally }));
    this.#needsWrite = true;
  }

  #serialize(work: () => Promise<void>): Promise<void> {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.#state), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.#file);
    } finally {
      await rm(temporary, { force: true });
    }
    this.#lastWrite = Date.now();
    this.#needsWrite = this.#urgentWrite = false;
  }

  async #dailyReport(at: string): Promise<void> {
    const hour = this.options.dailyHour;
    const today = dayOf(at);
    if (hour === undefined || wib(at).getUTCHours() < hour || this.#state.lastReportDay === today) return;
    const yesterday = dayBefore(today);
    if (!this.#state.days.some((item) => item.day === yesterday)) return;
    // Keep a failed Telegram delivery from retrying every monitoring sample.
    if (Date.parse(at) < this.#nextReportAttempt) return;
    this.#nextReportAttempt = Date.parse(at) + 5 * 60_000;
    await this.options.notify(this.#report(yesterday, yesterday));
    this.#state.lastReportDay = today;
    this.#needsWrite = this.#urgentWrite = true;
    await this.#save();
  }

  #nextReportAttempt = 0;

  #inventory(): string {
    const { assets, queues, backups, links } = this.options.inventory;
    const primary = assets.find((asset) => asset.id === "router-utama");
    const devices = assets.filter((asset) => asset !== primary);
    return [
      `**Inventaris NOC**\n${telegramLiteral(this.options.routerIdentity)} · RouterOS API${primary ? " + ICMP" : ""}`,
      devices.length ? ["**Perangkat tambahan**", ...devices.map((asset) =>
        `• ${telegramLiteral(asset.label)} (${asset.id}) · ${asset.kind.toUpperCase()} · ${asset.probe.kind.toUpperCase()}${asset.parent ? ` · induk ${asset.parent}` : ""}`,
      )].join("\n") : "Belum ada perangkat tambahan terdaftar.",
      `**Cakupan pemantauan**\n• ${queues.length} queue pelanggan atau segmen\n• ${links.length} link dengan data kapasitas\n• ${backups.length} sumber backup`,
    ].join("\n\n");
  }

  #incidents(): string {
    const all = this.#state.incidents;
    const open = all.filter((item) => !item.closedAt);
    const closed = all.filter((item) => item.closedAt);
    const render = (item: Incident) => {
      const status = item.closedAt ? "Pulih" : item.state === "fault" ? "Terganggu" : "Belum terukur";
      return [
        `**${item.id}** · ${telegramLiteral(item.key)}`,
        `${status} · ${telegramTime(item.closedAt ?? item.openedAt)}${!item.closedAt && item.acknowledgedAt ? " · sudah diakui" : ""}`,
        telegramLiteral(item.detail),
      ].join("\n");
    };
    const sections = [`**Insiden NOC**\n${open.length} terbuka`];
    if (open.length) sections.push(...open.slice(-20).reverse().map(render));
    if (open.length > 20) sections.push(`${open.length - 20} insiden terbuka lain tersimpan dalam riwayat.`);
    if (closed.length) sections.push(["**Pemulihan terbaru**", ...closed.slice(-5).reverse().map(render)].join("\n\n"));
    if (!all.length) sections.push("Belum ada insiden tercatat.");
    if (open.length) sections.push("Contoh tindak lanjut: /noc_ack NOC-1 atau /noc_escalate NOC-1. Gunakan ID dari daftar.");
    return sections.join("\n\n");
  }

  async #ack(ref: string): Promise<string> {
    let reply = "Insiden terbuka tidak ditemukan. Lihat /noc_incidents.";
    await this.#serialize(async () => {
      const incident = this.#state.incidents.find((item) => item.id === ref && !item.closedAt);
      if (!incident) return;
      if (!incident.acknowledgedAt) {
        incident.acknowledgedAt = new Date().toISOString();
        this.#needsWrite = this.#urgentWrite = true;
      }
      if (this.#urgentWrite) await this.#save();
      reply = `**${ref} sudah diakui**\n${telegramTime(incident.acknowledgedAt)}\n\nInsiden tetap terbuka sampai pemeriksaan pulih.`;
    });
    return reply;
  }

  #draft(ref: string, customer: boolean): string {
    const incident = this.#state.incidents.find((item) => item.id === ref);
    if (!incident) return "ID insiden tidak ditemukan. Lihat /noc_incidents.";
    if (customer && !/^(Ethernet |Default IPv4 |Perangkat )/.test(incident.key)) {
      return "Pemeriksaan ini bersifat internal. Verifikasi dampak layanan sebelum menyiapkan pengumuman pelanggan.";
    }
    if (customer) return incident.closedAt
      ? `**Draf untuk pelanggan** · ${ref}\n\nPemeriksaan kami kembali normal pada ${telegramTime(incident.closedAt)}. Kami tetap memantau layanan.\n\nJika koneksi Anda masih bermasalah, hubungi dukungan dan sertakan waktu kejadian.`
      : `**Draf untuk pelanggan** · ${ref}\n\nKami sedang memeriksa indikasi gangguan yang terdeteksi sejak ${telegramTime(incident.openedAt)}.\n\nKami masih memeriksa cakupan dan penyebabnya. Kami akan memberi kabar setelah ada hasil pemeriksaan.`;
    return [
      `**Draf eskalasi teknisi atau ISP** · ${ref}\n${telegramLiteral(incident.key)} · ${telegramLiteral(this.options.routerIdentity)}`,
      `Terdeteksi ${telegramTime(incident.openedAt)}\n${incident.closedAt ? `Pemeriksaan pulih ${telegramTime(incident.closedAt)}` : "Insiden masih terbuka."}`,
      `**Bukti terakhir**\n${telegramLiteral(incident.detail)}`,
      "**Tindak lanjut**\nMohon periksa perangkat atau jalur terkait. Sertakan temuan, tindakan, dan estimasi pemulihan jika tersedia. Dampak pelanggan masih perlu diverifikasi.",
    ].join("\n\n");
  }

  #report(from: string, to: string): string {
    const days = this.#state.days.filter((item) => item.day >= from && item.day <= to);
    const samples = days.reduce((sum, item) => sum + item.samples, 0);
    const incidents = this.#state.incidents;
    const within = (date: string) => dayOf(date) >= from && dayOf(date) <= to;
    const stats = new Map<string, Tally>();
    for (const day of days) for (const { key, tally } of day.metrics) {
      const old = stats.get(key);
      if (old?.unit === tally.unit) {
        old.count += tally.count;
        old.sum += tally.sum;
        old.peak = Math.max(old.peak, tally.peak);
        old.over80 += tally.over80;
      } else stats.set(key, { ...tally });
    }
    const capacity = [...stats].filter(([, tally]) => tally.over80 >= 3)
      .slice(0, 16).map(([key, tally]) => `• ${telegramLiteral(key)} · ${tally.over80}/${tally.count} sampel ≥80% kapasitas tercatat`);
    const events = this.#state.events.filter((item) => within(item.at));
    const openCount = incidents.filter((item) => within(item.openedAt)).length;
    const recoveredCount = incidents.filter((item) => item.closedAt && within(item.closedAt)).length;
    const sections = [
      `**Laporan NOC**\n${telegramLiteral(this.options.routerIdentity)} · ${from === to ? from : `${from} s.d. ${to}`} (WIB)`,
      `**Ringkasan**\n${samples} sampel · ${openCount} insiden baru · ${recoveredCount} pulih`,
    ];
    const selected = [...stats].slice(0, 36);
    for (const [label, items] of [
      ["Performa router", selected.filter(([key]) => /^(CPU|RAM) MikroTik$/.test(key))],
      ["Koneksi perangkat", selected.filter(([key]) => key.startsWith("Perangkat "))],
      ["Trafik dan pemakaian kapasitas", selected.filter(([key]) => !/^(Perangkat |(CPU|RAM) MikroTik$)/.test(key))],
    ] as const) {
      if (items.length) sections.push([`**${label}**`, ...items.map(([key, t]) =>
        `• ${telegramLiteral(key)}\n  Rata-rata ${(t.sum / t.count).toFixed(2)} ${t.unit} · puncak ${t.peak.toFixed(2)} ${t.unit} · ${t.count} sampel`,
      )].join("\n"));
    }
    if (capacity.length) sections.push(["**Kapasitas perlu ditinjau**", ...capacity].join("\n"));
    if (events.length) sections.push([
      `**Catatan terakhir** · ${events.length} tersimpan`,
      ...events.slice(-5).map((item) => `• ${telegramTime(item.at)} · ${telegramLiteral(item.detail)}`),
    ].join("\n"));
    if (stats.size > selected.length) sections.push(`${stats.size - selected.length} metrik lain tersimpan dalam ringkasan lokal.`);
    if (!samples) sections.push("Belum ada sampel di periode ini.");
    else if (!stats.size) sections.push("Belum ada metrik yang berhasil dibaca pada periode ini.");
    else sections.push("Rata-rata dan puncak dihitung dari sampel yang tersedia. Trafik ini belum mengukur throughput internet pelanggan atau SLA.");
    return sections.join("\n\n");
  }
}

export function reportHour(raw: string | undefined): number | undefined {
  const value = raw?.trim().toLowerCase() || "8";
  if (value === "off") return undefined;
  if (!/^\d{1,2}$/.test(value) || Number(value) > 23) throw new Error("NOC_REPORT_HOUR_WIB harus 0–23 atau off");
  return Number(value);
}
