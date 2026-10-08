import { readFileSync } from "node:fs";

export interface RouterOsConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
  tlsRejectUnauthorized: boolean;
  tlsServerName?: string;
  tlsCa?: Buffer;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
  maxRows: number;
  writeEnabled: boolean;
  sensitiveReadEnabled: boolean;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${name} wajib diisi`);
  }
  return value;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} harus berupa true atau false`);
}

function integerValue(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} harus bilangan bulat ${minimum}-${maximum}`);
  }
  return value;
}

export function loadConfig(): RouterOsConfig {
  const tls = booleanValue("MIKROTIK_TLS", false);
  const caFile = process.env.MIKROTIK_TLS_CA_FILE?.trim();
  const tlsServerName = process.env.MIKROTIK_TLS_SERVER_NAME?.trim();

  return {
    host: required("MIKROTIK_HOST"),
    port: integerValue("MIKROTIK_PORT", tls ? 8729 : 8728, 1, 65535),
    username: required("MIKROTIK_USERNAME"),
    password: required("MIKROTIK_PASSWORD"),
    tls,
    tlsRejectUnauthorized: booleanValue(
      "MIKROTIK_TLS_REJECT_UNAUTHORIZED",
      true,
    ),
    ...(tlsServerName ? { tlsServerName } : {}),
    ...(caFile ? { tlsCa: readFileSync(caFile) } : {}),
    connectTimeoutMs: integerValue(
      "MIKROTIK_CONNECT_TIMEOUT_MS",
      8_000,
      500,
      120_000,
    ),
    commandTimeoutMs: integerValue(
      "MIKROTIK_COMMAND_TIMEOUT_MS",
      15_000,
      500,
      300_000,
    ),
    maxRows: integerValue("MIKROTIK_MAX_ROWS", 2_000, 1, 20_000),
    writeEnabled: booleanValue("MIKROTIK_WRITE_ENABLED", false),
    sensitiveReadEnabled: booleanValue(
      "MIKROTIK_SENSITIVE_READ_ENABLED",
      false,
    ),
  };
}
