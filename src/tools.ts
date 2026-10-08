import { RouterOsClient, type CommandOptions } from "./client.js";
import { loadConfig, type RouterOsConfig } from "./config.js";

export const INSPECTION_TARGETS = {
  interfaces: "/interface/print",
  ip_addresses: "/ip/address/print",
  routes: "/ip/route/print",
  arp: "/ip/arp/print",
  dhcp_leases: "/ip/dhcp-server/lease/print",
  firewall_filter: "/ip/firewall/filter/print",
  neighbors: "/ip/neighbor/print",
  dns_cache: "/ip/dns/cache/print",
  logs: "/log/print",
} as const;

const SENSITIVE_READ_PATHS = [
  "/certificate",
  "/file",
  "/interface/wireguard",
  "/ip/hotspot/profile",
  "/ip/hotspot/user",
  "/ip/ipsec",
  "/ppp/secret",
  "/radius",
  "/snmp/community",
  "/system/backup",
  "/system/script",
  "/tool/e-mail",
  "/user",
];

const WRITE_ACTIONS = new Set([
  "add",
  "disable",
  "enable",
  "move",
  "remove",
  "reset-counters",
  "set",
]);

export async function inspectRouter(
  target: keyof typeof INSPECTION_TARGETS | "router",
  limit: number,
): Promise<unknown> {
  return withClient(async (client) => {
    if (target === "router") {
      const identity = await client.command("/system/identity/print", { limit: 1 });
      const resource = await client.command("/system/resource/print", { limit: 1 });
      return { identity: identity[0] ?? {}, resource: resource[0] ?? {} };
    }
    const rows = await client.command(INSPECTION_TARGETS[target], { limit });
    return { target, count: rows.length, rows };
  });
}

export async function runReadCommand(
  command: string,
  options: CommandOptions,
): Promise<unknown> {
  const config = loadConfig();
  validateReadCommand(command, config);
  validateOptions(options);
  return withClient(
    async (client) => {
      const rows = await client.command(command, options);
      return { command, count: rows.length, rows };
    },
    config,
  );
}

export async function runWriteCommand(
  command: string,
  attributes: Record<string, string | number | boolean>,
): Promise<unknown> {
  const config = loadConfig();
  if (!config.writeEnabled) {
    throw new Error(
      "Operasi tulis dinonaktifkan. Set MIKROTIK_WRITE_ENABLED=true lalu restart MCP server.",
    );
  }
  validateWriteCommand(command);
  validateOptions({ attributes });
  return withClient(
    async (client) => {
      const rows = await client.command(command, { attributes, limit: 20 });
      return { command, status: "done", rows };
    },
    config,
  );
}

function validateReadCommand(command: string, config: RouterOsConfig): void {
  validateCommandPath(command);
  if (!command.endsWith("/print") && !command.endsWith("/getall")) {
    throw new Error("Query baca hanya mengizinkan command /print atau /getall");
  }
  const lower = command.toLowerCase();
  const sensitive = SENSITIVE_READ_PATHS.some(
    (path) => lower === path || lower.startsWith(`${path}/`),
  );
  if (sensitive && !config.sensitiveReadEnabled) {
    throw new Error(
      "Path ini dapat membocorkan credential atau private key. Set MIKROTIK_SENSITIVE_READ_ENABLED=true jika benar-benar diperlukan.",
    );
  }
}

function validateWriteCommand(command: string): void {
  validateCommandPath(command);
  const action = command.slice(command.lastIndexOf("/") + 1).toLowerCase();
  if (!WRITE_ACTIONS.has(action)) {
    throw new Error(
      `Aksi /${action} tidak diizinkan. Gunakan add, set, remove, enable, disable, move, atau reset-counters.`,
    );
  }
}

function validateCommandPath(command: string): void {
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(command) || command.includes("..")) {
    throw new Error("Command RouterOS tidak valid");
  }
}

function validateOptions(options: CommandOptions): void {
  for (const key of Object.keys(options.attributes ?? {})) {
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
      throw new Error(`Nama attribute tidak valid: ${key}`);
    }
  }
  for (const query of options.queries ?? []) {
    if (!/^\?[^\0\r\n]{1,512}$/.test(query)) {
      throw new Error(`Query word tidak valid: ${query}`);
    }
  }
  for (const property of options.proplist ?? []) {
    if (!/^[a-zA-Z0-9._-]+$/.test(property)) {
      throw new Error(`Nama property tidak valid: ${property}`);
    }
  }
}

async function withClient<T>(
  operation: (client: RouterOsClient) => Promise<T>,
  config: RouterOsConfig = loadConfig(),
): Promise<T> {
  const client = new RouterOsClient(config);
  try {
    await client.connect();
    return await operation(client);
  } finally {
    client.close();
  }
}
