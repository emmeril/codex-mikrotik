#!/usr/bin/env node
import { CodexAppServerRunner } from "./codex-app-server.js";
import { CodexCliRunner, CodexTelegramAgent } from "./telegram-agent.js";
import { createTelegramApi, TelegramBot } from "./telegram-bot.js";
import { loadTelegramAgentConfig } from "./telegram-config.js";
import { loadConfig } from "./config.js";
import { NocMonitor, readNocSnapshot } from "./noc-monitor.js";
import { NocLogWatcher } from "./noc-logs.js";
import { loadNocInventory } from "./noc-inventory.js";
import { measureNoc } from "./noc-measurements.js";
import { NocOperations, reportHour } from "./noc-operations.js";
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
  const inventory = nocConfig ? loadNocInventory(process.env.NOC_INVENTORY_FILE?.trim(), {
    host: routerConfig.host, identity: nocConfig.expectedIdentity,
  }) : undefined;
  const stateFile = process.env.NOC_STATE_FILE?.trim();
  const dailyHour = nocConfig ? reportHour(process.env.NOC_REPORT_HOUR_WIB) : undefined;
  const notifyNoc = async (message: string) => {
    if (!nocConfig) return;
    for (const chunk of splitTelegramText(message)) await api.sendMessage(nocConfig.recipient, chunk);
  };
  const operations = nocConfig && inventory ? new NocOperations({
    routerIdentity: nocConfig.expectedIdentity, inventory, notify: notifyNoc,
    ...(stateFile ? { file: stateFile } : {}),
    ...(dailyHour === undefined ? {} : { dailyHour }),
  }) : undefined;
  const logWatcher = nocConfig?.logEnabled ? new NocLogWatcher({
    interfaces: nocConfig.interfaces,
    ...(inventory ? { firewallLogPrefixes: inventory.firewallLogPrefixes } : {}),
    ...(nocConfig.wanSessionNames ? { wanSessionNames: nocConfig.wanSessionNames } : {}),
    maxRows: routerConfig.maxRows,
  }) : undefined;
  const noc = nocConfig && inventory && operations ? new NocMonitor({
    config: nocConfig,
    read: async () => measureNoc(await readNocSnapshot(routerConfig, nocConfig, logWatcher), routerConfig, nocConfig, inventory),
    notify: notifyNoc,
    diagnose: (snapshot) => agent.diagnoseNocIncident(nocConfig.expectedIdentity, snapshot),
    observe: (snapshot, changes) => operations.observe(snapshot, changes),
    previousStates: operations.activeStates(),
    incidentRef: (key, observedAt) => operations.incidentRef(key, observedAt),
  }) : undefined;
  const bot = new TelegramBot({
    api,
    agent,
    allowedUserIds: config.allowedUserIds,
    privateOnly: config.privateOnly,
    pollTimeoutSeconds: config.pollTimeoutSeconds,
    ...(nocConfig && noc && operations ? { noc: {
      recipient: nocConfig.recipient, status: () => noc.status(),
      command: (command, argument) => operations.command(command, argument),
      recordChange: (completed, ok) => operations.recordChange(completed, ok),
    } } : {}),
  });

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());

  console.error(`MikroTik Telegram agent ready (Codex ${config.codexTransport})`);
  try {
    await Promise.all([bot.run(controller.signal), noc?.run(controller.signal)]);
  } finally {
    controller.abort();
    await operations?.flush().catch(() => console.error("NOC gagal menyimpan riwayat terakhir."));
    await runner.close?.();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
