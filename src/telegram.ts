#!/usr/bin/env node
import { CodexAppServerRunner } from "./codex-app-server.js";
import { CodexCliRunner, CodexTelegramAgent } from "./telegram-agent.js";
import { createTelegramApi, TelegramBot } from "./telegram-bot.js";
import { loadTelegramAgentConfig } from "./telegram-config.js";
import { loadConfig } from "./config.js";
import { NocMonitor, readNocSnapshot } from "./noc-monitor.js";
import { splitTelegramText } from "./telegram-api.js";

async function main(): Promise<void> {
  const config = loadTelegramAgentConfig();
  const routerConfig = loadConfig();
  const runner = config.codexTransport === "app-server"
    ? new CodexAppServerRunner({
        binary: config.codexBinary,
        cwd: process.cwd(),
        ...(config.codexModel ? { model: config.codexModel } : {}),
        ...(config.codexReasoningEffort
          ? { reasoningEffort: config.codexReasoningEffort }
          : {}),
        ...(config.codexServiceTier ? { serviceTier: config.codexServiceTier } : {}),
        timeoutMs: config.codexTimeoutMs,
      })
    : new CodexCliRunner({
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
  const api = createTelegramApi(config.botToken);
  const nocConfig = config.noc;
  const noc = nocConfig && new NocMonitor({
    config: nocConfig,
    read: () => readNocSnapshot(routerConfig, nocConfig),
    notify: async (message) => {
      for (const chunk of splitTelegramText(message)) await api.sendMessage(nocConfig.recipient, chunk);
    },
    diagnose: (snapshot) => agent.diagnoseNocIncident(nocConfig.expectedIdentity, snapshot),
  });
  const bot = new TelegramBot({
    api,
    agent,
    allowedUserIds: config.allowedUserIds,
    privateOnly: config.privateOnly,
    pollTimeoutSeconds: config.pollTimeoutSeconds,
    ...(nocConfig && noc ? { noc: { recipient: nocConfig.recipient, status: () => noc.status() } } : {}),
  });

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  console.error(`MikroTik Telegram agent ready (Codex ${config.codexTransport})`);
  try {
    await Promise.all([bot.run(controller.signal), noc?.run(controller.signal)]);
  } finally {
    controller.abort();
    await runner.close?.();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
