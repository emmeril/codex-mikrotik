export interface TelegramAgentConfig {
  botToken: string;
  allowedUserIds: Set<string>;
  privateOnly: boolean;
  pollTimeoutSeconds: number;
  pendingChangeTtlMs: number;
  codexBinary: string;
  codexModel?: string;
  codexTimeoutMs: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} wajib diisi`);
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

export function loadTelegramAgentConfig(): TelegramAgentConfig {
  const botToken = required("TELEGRAM_BOT_TOKEN");
  if (!/^\d{5,20}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    throw new Error("TELEGRAM_BOT_TOKEN tidak memiliki format token bot yang valid");
  }

  const allowedUserIds = new Set(
    required("TELEGRAM_ALLOWED_USER_IDS")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const id of allowedUserIds) {
    if (!/^\d+$/.test(id)) {
      throw new Error("TELEGRAM_ALLOWED_USER_IDS harus berisi ID numerik dipisahkan koma");
    }
  }

  return {
    botToken,
    allowedUserIds,
    privateOnly: booleanValue("TELEGRAM_PRIVATE_ONLY", true),
    pollTimeoutSeconds: integerValue("TELEGRAM_POLL_TIMEOUT_SECONDS", 30, 1, 50),
    pendingChangeTtlMs: integerValue(
      "TELEGRAM_CONFIRM_TTL_SECONDS",
      300,
      30,
      3600,
    ) * 1_000,
    codexBinary: process.env.CODEX_BIN?.trim() || "codex",
    ...(process.env.CODEX_MODEL?.trim()
      ? { codexModel: process.env.CODEX_MODEL.trim() }
      : {}),
    codexTimeoutMs: integerValue("CODEX_TIMEOUT_SECONDS", 300, 30, 1_800) * 1_000,
  };
}
