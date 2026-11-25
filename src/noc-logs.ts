import type { RouterOsClient, RouterOsRecord } from "./client.js";

const LOG_CAP = 2_000;
const ALERT_WINDOW_MS = 5 * 60_000;
const LOGIN_THRESHOLD = 5;
const FIREWALL_THRESHOLD = 20;
const MEMORY_FILTER = "?buffer=memory";
const TOPIC_LIST = /^[a-z0-9-]+(?:,[a-z0-9-]+){0,15}$/;

export class NocLogReadError extends Error {}

export interface NocLogSample {
  detail: string;
  alerts: string[];
}

type LogReader = Pick<RouterOsClient, "command">;

export class NocLogWatcher {
  #seen: Map<string, string> | undefined;
  #uptimeSeconds: number | undefined;
  readonly #signalSamples = new Map<string, { at: number; count: number }[]>();
  readonly #pending = new Map<string, number>();
  readonly #sentAt = new Map<string, number>();
  readonly #interfaces: readonly string[];
  readonly #wanSessions: readonly string[];
  readonly #maxRows: number;
  readonly #firewallPrefixes: readonly string[];
  readonly #now: () => number;

  constructor(options: {
    interfaces: readonly string[];
    wanSessionNames?: readonly string[];
    firewallLogPrefixes?: readonly string[];
    maxRows: number;
    now?: () => number;
  }) {
    this.#interfaces = options.interfaces;
    this.#wanSessions = options.wanSessionNames ?? options.interfaces;
    this.#firewallPrefixes = options.firewallLogPrefixes ?? [];
    this.#maxRows = Math.min(options.maxRows, LOG_CAP);
    this.#now = options.now ?? Date.now;
  }

  async sample(client: LogReader, uptime: string | undefined): Promise<NocLogSample> {
    const [action] = await client.command("/system/logging/action/print", {
      queries: ["?name=memory", "?target=memory"],
      proplist: ["memory-lines", "memory-stop-on-full"],
      limit: 1,
      replyBudget: { maxRows: 1, timeoutMs: 5_000 },
    });
    const capacity = Number(action?.["memory-lines"]);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > this.#maxRows) {
      throw new NocLogReadError("Kapasitas buffer memory belum diketahui atau melebihi batas pembacaan NOC.");
    }
    if (!["false", "no"].includes(action?.["memory-stop-on-full"] ?? "")) {
      throw new NocLogReadError("Belum terverifikasi bahwa buffer memory terus menerima log ketika penuh.");
    }

    const options = { limit: capacity, replyBudget: { maxRows: capacity, timeoutMs: 7_000 } };
    const rows = await client.command("/log/print", {
      ...options, queries: [MEMORY_FILTER], proplist: [".id", "topics"],
    });
    const seen = new Map<string, string>();
    for (const row of rows) {
      const id = row[".id"];
      if (!id || !/^\*[0-9a-f]+$/i.test(id) || !row.topics || seen.has(id)) {
        throw new NocLogReadError("Entri log tidak memiliki ID dan topik unik yang dapat dibandingkan.");
      }
      seen.set(id, row.topics);
    }

    const previous = this.#seen;
    const uptimeSeconds = uptimeInSeconds(uptime);
    if (!previous) {
      this.#seen = seen;
      this.#uptimeSeconds = uptimeSeconds;
      return { detail: `Sampel awal disimpan (${seen.size} entri di buffer memory).`, alerts: [] };
    }

    const restarted = uptimeSeconds !== undefined && this.#uptimeSeconds !== undefined
      && uptimeSeconds < this.#uptimeSeconds;
    const newEntries = [...seen].filter(([id, topics]) => restarted || previous.get(id) !== topics);
    const candidates = newEntries.filter(([, topics]) => watchedTopics(topics, this.#firewallPrefixes.length > 0));
    const topics = [...new Set(candidates.map(([, value]) => value))];
    const details = topics.length ? await client.command("/log/print", {
      ...options, queries: topicQueries(topics.slice(0, 16)), proplist: [".id", "topics", "message"],
    }) : [];
    const byId = new Map(details.map((row) => [row[".id"], row]));
    let gap = restarted || (previous.size > 0 && newEntries.length === seen.size);
    const signals = new Map<string, number>();
    let rebootLog = false;

    for (const [id, expectedTopics] of candidates) {
      const row = byId.get(id);
      if (!row || row.topics !== expectedTopics || row.message === undefined) {
        gap = true;
        continue;
      }
      const event = this.#classify(row);
      if (event === "login" || event?.startsWith("firewall:")) signals.set(event, (signals.get(event) ?? 0) + 1);
      else if (event === "reboot") rebootLog = true;
      else if (event) this.#add(event);
    }

    this.#seen = seen;
    this.#uptimeSeconds = uptimeSeconds;
    if (gap) this.#add("Cakupan log terputus. Sebagian kejadian mungkin tidak terbaca");
    if (restarted || rebootLog) this.#add(rebootLog
      ? "Log sistem mencatat router reboot" : "Uptime router turun sejak pembacaan sebelumnya");
    const alerts = this.#summarize(signals);
    return {
      detail: `${newEntries.length} entri baru terbaca dari buffer memory.${gap ? " Riwayat antar pembacaan tidak utuh." : ""}`,
      alerts,
    };
  }

  #classify(row: RouterOsRecord): string | undefined {
    const topics = row.topics!.split(",");
    const message = row.message!.slice(0, 512);
    if (topics.includes("system")) {
      if (/^login failure for user\b/i.test(message)) return "login";
      if (/^router rebooted\b/i.test(message)) return "reboot";
    }
    if (topics.includes("firewall")) {
      const match = this.#firewallPrefixes.find((prefix) => message.startsWith(prefix)
        && /^(?:$|[\s:])/.test(message.slice(prefix.length)));
      if (match) return `firewall:${match}`;
    }
    if (topics.includes("interface")) {
      const name = this.#interfaces.find((port) => message.startsWith(`${port} link down`)
        && /^(?:$|\s|\()/.test(message.slice(port.length + " link down".length)));
      if (name) return `Ethernet ${name} mencatat link putus`;
    }
    if (topics.includes("dhcp")) {
      const name = this.#interfaces.find((port) =>
        message.startsWith(`dhcp-client on ${port} lost `) || message.startsWith(`dhcp-client on ${port} deassigned `));
      if (name) return `DHCP client di ${name} kehilangan lease`;
    }
    if (topics.includes("pppoe") || topics.includes("ppp")) {
      const name = this.#wanSessions.find((session) => message.startsWith(`${session}: `)
        && /^(?:disconnected|link down)\b/i.test(message.slice(session.length + 2)));
      if (name) return `Sesi WAN ${name} terputus`;
    }
    return undefined;
  }

  #add(label: string): void {
    this.#pending.set(label, (this.#pending.get(label) ?? 0) + 1);
  }

  #summarize(signals: ReadonlyMap<string, number>): string[] {
    const now = this.#now();
    const alerts: string[] = [];
    for (const [label, count] of this.#pending) {
      if (now - (this.#sentAt.get(label) ?? -Infinity) < ALERT_WINDOW_MS) continue;
      this.#sentAt.set(label, now);
      this.#pending.delete(label);
      alerts.push(count === 1 ? label : `${label} (${count} kejadian)`);
    }

    for (const [key, count] of signals) {
      this.#signalSamples.set(key, [...(this.#signalSamples.get(key) ?? []), { at: now, count }]);
    }
    for (const [key, history] of this.#signalSamples) {
      const samples = history.filter(({ at }) => now - at <= ALERT_WINDOW_MS);
      const total = samples.reduce((sum, sample) => sum + sample.count, 0);
      if (total >= (key === "login" ? LOGIN_THRESHOLD : FIREWALL_THRESHOLD)
        && now - (this.#sentAt.get(key) ?? -Infinity) >= ALERT_WINDOW_MS) {
        alerts.push(key === "login" ? `${total} kegagalan login router baru terbaca dalam 5 menit`
          : `${total} entri firewall dengan prefix ${key.slice("firewall:".length)} baru terbaca dalam 5 menit`);
        this.#signalSamples.delete(key);
        this.#sentAt.set(key, now);
      } else if (samples.length) this.#signalSamples.set(key, samples);
      else this.#signalSamples.delete(key);
    }
    return alerts;
  }
}

function watchedTopics(value: string, watchFirewall: boolean): boolean {
  if (value.length > 200 || !TOPIC_LIST.test(value)) return false;
  const topics = value.split(",");
  if (topics.includes("debug") || topics.includes("packet")) return false;
  if (topics.includes("system")) {
    return !topics.includes("account") || ["warning", "error", "critical"].some((severity) => topics.includes(severity));
  }
  return (watchFirewall && topics.includes("firewall"))
    || ["interface", "dhcp", "pppoe", "ppp"].some((topic) => topics.includes(topic));
}

function topicQueries(topics: string[]): string[] {
  const queries = [MEMORY_FILTER];
  topics.forEach((topic, index) => {
    queries.push(`?topics=${topic}`);
    if (index) queries.push("?#|");
  });
  return [...queries, "?#&"];
}

function uptimeInSeconds(uptime: string | undefined): number | undefined {
  if (!uptime || !/^(?:\d+w)?(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?$/.test(uptime)) return undefined;
  const units: Record<string, number> = { w: 604_800, d: 86_400, h: 3_600, m: 60, s: 1 };
  return [...uptime.matchAll(/(\d+)([wdhms])/g)].reduce((sum, [, amount, unit]) =>
    sum + Number(amount) * (units[unit ?? ""] ?? 0), 0);
}
