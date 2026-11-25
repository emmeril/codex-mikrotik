import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import * as z from "zod/v4";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/);
const label = z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]+$/);
const ip = z.string().refine((value) => isIP(value) !== 0 && !value.includes("%"));
const percent = z.number().min(1).max(100);

const inventorySchema = z.strictObject({
  assets: z.array(z.strictObject({
    id,
    label,
    kind: z.enum(["router", "olt", "ont", "ap", "server", "isp"]),
    parent: id.optional(),
    probe: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("icmp"), address: ip,
        maxLossPct: percent.default(20), maxRttMs: z.number().positive().optional(),
      }),
      z.strictObject({ kind: z.literal("tcp"), address: ip, port: z.number().int().min(1).max(65535) }),
    ]),
  })).max(16).default([]),
  links: z.array(z.strictObject({
    interface: label,
    rxMbps: z.number().positive().optional(),
    txMbps: z.number().positive().optional(),
  })).max(8).default([]),
  queues: z.array(z.strictObject({ name: label, label })).max(8).default([]),
  backups: z.array(z.strictObject({
    id, label, path: z.string().min(1).max(512), maxAgeHours: z.number().int().min(1).max(8_760),
  })).max(8).default([]),
  firewallLogPrefixes: z.array(z.string().regex(/^[a-zA-Z0-9_-]{3,32}$/)).max(6).default([]),
  probeMainRouter: z.boolean().default(true),
  cpuAlertPct: percent.default(85),
  ramAlertPct: percent.default(85),
});

export type NocInventory = z.output<typeof inventorySchema>;

export function loadNocInventory(file: string | undefined, managedRouter?: { host: string; identity: string }): NocInventory {
  const path = file ? resolve(file) : undefined;
  const parsed = inventorySchema.safeParse(path ? readInventory(path) : {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean);
    throw new Error(`Inventaris NOC tidak valid pada ${fields.join(", ") || "struktur JSON"}`);
  }
  const cfg = parsed.data;
  if (cfg.probeMainRouter && managedRouter && ip.safeParse(managedRouter.host).success) {
    cfg.assets.unshift({ id: "router-utama", kind: "router", label: managedRouter.identity,
      probe: { kind: "icmp", address: managedRouter.host, maxLossPct: 20 } });
  }
  unique(cfg.assets.map((x) => x.id), "ID perangkat");
  unique(cfg.links.map((x) => x.interface), "nama interface");
  unique(cfg.queues.map((x) => x.name), "nama queue");
  unique(cfg.queues.map((x) => x.label), "label queue");
  unique(cfg.backups.map((x) => x.id), "ID backup");
  unique(cfg.firewallLogPrefixes, "prefix log firewall");
  const parents = new Map(cfg.assets.map((x) => [x.id, x.parent]));
  for (const asset of cfg.assets) {
    const chain = new Set([asset.id]);
    for (let next = asset.parent; next !== undefined; next = parents.get(next)) {
      if (!parents.has(next) || chain.has(next)) throw new Error("Relasi parent pada inventaris NOC tidak valid");
      chain.add(next);
    }
  }
  return { ...cfg, backups: cfg.backups.map((entry) => ({ ...entry, path: resolve(path ? dirname(path) : ".", entry.path) })) };
}

function readInventory(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Inventaris NOC harus berupa file JSON maksimal 64 KiB");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Inventaris NOC tidak dapat dibaca sebagai JSON");
  }
}

function unique(items: string[], field: string): void {
  if (new Set(items).size !== items.length) throw new Error(`${field} pada inventaris NOC harus unik`);
}
