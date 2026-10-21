#!/usr/bin/env node
import { CodexCliRunner, CodexTelegramAgent } from "./telegram-agent.js";
import { createTelegramApi, TelegramBot } from "./telegram-bot.js";
import { loadTelegramAgentConfig } from "./telegram-config.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadTelegramAgentConfig();
  const routerConfig = loadConfig();
  const runner = new CodexCliRunner({
    binary: config.codexBinary,
    cwd: process.cwd(),
    ...(config.codexModel ? { model: config.codexModel } : {}),
    timeoutMs: config.codexTimeoutMs,
  });
  const agent = new CodexTelegramAgent({
    runner,
    writeEnabled: routerConfig.writeEnabled,
    pendingChangeTtlMs: config.pendingChangeTtlMs,
  });
  const bot = new TelegramBot({
    api: createTelegramApi(config.botToken),
    agent,
    allowedUserIds: config.allowedUserIds,
    privateOnly: config.privateOnly,
    pollTimeoutSeconds: config.pollTimeoutSeconds,
  });

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  console.error("MikroTik Telegram agent ready (Codex CLI auth)");
  await bot.run(controller.signal);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
