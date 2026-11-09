import { isIP } from "node:net";
import type { RouterOsConfig } from "./config.js";
import { withClient } from "./tools.js";

export async function monitorEthernet(interfaces: string[], config?: RouterOsConfig) {
  validateInterfaces(interfaces);
  return withClient(async (client) => {
    const observations = [];
    for (const name of interfaces) {
      const [settings] = await client.command("/interface/ethernet/print", {
        queries: [`?name=${name}`],
        proplist: [".id", "name", "speed", "auto-negotiation", "running", "disabled"],
        limit: 1,
      });
      if (!settings?.[".id"]) throw new Error(`Interface Ethernet tidak ditemukan: ${name}`);
      const [status] = await client.command("/interface/ethernet/monitor", {
        attributes: { numbers: settings[".id"], once: true },
        proplist: ["name", "status", "rate", "full-duplex", "auto-negotiation", "advertising", "link-partner-advertising"],
        limit: 1,
      });
      if (!status) throw new Error(`Monitor tidak mengembalikan status: ${name}`);
      const linkOk = status.status === "link-ok";
      observations.push({
        name,
        observed_at: new Date().toISOString(),
        configured_speed: settings.speed ?? null,
        auto_negotiation_enabled: routerBoolean(settings["auto-negotiation"]),
        link_status: status.status ?? null,
        negotiated_rate: linkOk ? status.rate ?? null : null,
        negotiated_full_duplex: linkOk ? routerBoolean(status["full-duplex"]) : null,
        monitor: status,
      });
    }
    return {
      source: "/interface/ethernet/monitor",
      meaning: "negotiated_rate adalah rate link aktual; configured_speed bukan hasil negosiasi. Null berarti belum terverifikasi. Rate link bukan bandwidth paket ISP atau throughput internet.",
      interfaces: observations,
    };
  }, config);
}

export async function monitorTraffic(interfaces: string[], config?: RouterOsConfig) {
  validateInterfaces(interfaces);
  return withClient(async (client) => {
    const observations = [];
    for (const name of interfaces) {
      const [found] = await client.command("/interface/print", {
        queries: [`?name=${name}`], proplist: [".id", "name"], limit: 1,
      });
      if (!found?.[".id"]) throw new Error(`Interface tidak ditemukan: ${name}`);
      const [traffic] = await client.command("/interface/monitor-traffic", {
        attributes: { interface: found[".id"], once: true },
        proplist: ["name", "rx-bits-per-second", "tx-bits-per-second", "rx-packets-per-second", "tx-packets-per-second"],
        limit: 1,
      });
      if (!traffic) throw new Error(`Monitor trafik tidak mengembalikan data: ${name}`);
      observations.push({ name, observed_at: new Date().toISOString(), ...traffic });
    }
    return {
      source: "/interface/monitor-traffic",
      units: "bits/s dan packets/s, dilihat dari router. Pada WAN langsung, RX biasanya download dan TX upload. Trafik sesaat bukan speed test atau kapasitas paket ISP.",
      interfaces: observations,
    };
  }, config);
}

export interface PingOptions {
  address: string;
  count?: number | undefined;
  interface?: string | undefined;
  src_address?: string | undefined;
  routing_table?: string | undefined;
}

export async function pingRouter(options: PingOptions, config?: RouterOsConfig) {
  const count = options.count ?? 5;
  if (!Number.isInteger(count) || count < 1 || count > 10) {
    throw new Error("Ping count harus bilangan bulat antara 1 dan 10");
  }
  if (!isIP(options.address) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(options.address)) {
    throw new Error("Alamat ping harus IP atau hostname");
  }
  if (options.src_address !== undefined && !isIP(options.src_address)) {
    throw new Error("src_address harus alamat IP tanpa prefix");
  }
  if (options.interface !== undefined) validateInterfaces([options.interface]);
  if (options.routing_table !== undefined) validateName(options.routing_table);
  const attributes = {
    address: options.address, count, interval: "200ms",
    ...(options.interface !== undefined ? { interface: options.interface } : {}),
    ...(options.src_address !== undefined ? { "src-address": options.src_address } : {}),
    ...(options.routing_table !== undefined ? { "routing-table": options.routing_table } : {}),
  };
  return withClient(async (client) => {
    const rows = await client.command("/ping", { attributes, limit: 10 });
    return {
      observed_at: new Date().toISOString(), source: "/ping", probe: attributes, rows,
      meaning: "Ini probe ICMP dari router, bukan dari klien. Gagal ping tidak membuktikan ISP mati. src-address saja tidak memastikan jalur ISP; periksa tabel/rule routing dan return path. Parameter yang tidak didukung versi router akan menghasilkan error, bukan dihapus diam-diam.",
    };
  }, config);
}

function validateInterfaces(interfaces: string[]): void {
  if (interfaces.length < 1 || interfaces.length > 16 || new Set(interfaces).size !== interfaces.length) {
    throw new Error("Pilih 1 sampai 16 nama interface yang berbeda");
  }
  for (const name of interfaces) validateName(name);
}

function validateName(name: string): void {
  if (!name.trim() || name.length > 100 || /[,\x00-\x1f\x7f]/.test(name) || name === "all") {
    throw new Error("Gunakan satu nama spesifik, bukan daftar atau all");
  }
}

function routerBoolean(value: string | undefined): boolean | null {
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  return null;
}
