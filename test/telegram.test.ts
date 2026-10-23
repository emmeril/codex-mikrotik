import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexEnvironment,
  CodexTelegramAgent,
  PendingChangeStore,
  type AgentReply,
  type ChangeExecutionResult,
  type CodexRunner,
  type CodexRunResult,
  type PendingLookup,
  type TelegramAgentService,
} from "../src/telegram-agent.js";
import { splitTelegramText, type TelegramMessage } from "../src/telegram-api.js";
import { TelegramBot } from "../src/telegram-bot.js";
import { validateWriteOperation } from "../src/tools.js";

test("Codex child environment excludes application secrets", () => {
  const environment = buildCodexEnvironment({
    HOME: "/root",
    PATH: "/usr/bin",
    TELEGRAM_BOT_TOKEN: "telegram-secret",
    MIKROTIK_PASSWORD: "router-secret",
    OPENAI_API_KEY: "api-secret",
    CODEX_API_KEY: "codex-secret",
  });

  assert.deepEqual(environment, { HOME: "/root", PATH: "/usr/bin" });
});

test("pending changes are bound to their chat and user and are single use", () => {
  const store = new PendingChangeStore(60_000, () => 1_000);
  const plan = store.create(10, "20", "add address", [
    { command: "/ip/address/add", attributes: { address: "10.0.0.1/24" } },
  ]);

  assert.deepEqual(store.take(11, "20", plan.id), { ok: false, reason: "forbidden" });
  assert.deepEqual(store.take(10, "21", plan.id), { ok: false, reason: "forbidden" });
  assert.equal(store.take(10, "20", plan.id).ok, true);
  assert.deepEqual(store.take(10, "20", plan.id), { ok: false, reason: "not_found" });
});

test("expired changes cannot be confirmed", () => {
  let now = 1_000;
  const store = new PendingChangeStore(5_000, () => now);
  const plan = store.create(10, "20", "disable interface", [
    { command: "/interface/disable", attributes: { ".id": "*1" } },
  ]);
  now = 6_000;
  assert.deepEqual(store.take(10, "20", plan.id), { ok: false, reason: "expired" });
});

test("long Telegram messages are split below the platform limit", () => {
  const text = `${"word ".repeat(1_000)}\n${"tail ".repeat(300)}`;
  const chunks = splitTelegramText(text, 500);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 500));
  assert.match(chunks.at(-1) ?? "", /tail/);
});

test("Telegram change previews reject non-allowlisted RouterOS actions", () => {
  assert.doesNotThrow(() => validateWriteOperation("/ip/address/add", {
    address: "10.0.0.1/24",
  }));
  assert.throws(
    () => validateWriteOperation("/system/reboot", {}),
    /tidak diizinkan/,
  );
});

test("unauthorized Telegram users cannot reach the agent", async () => {
  const api = new FakeTelegramApi();
  const agent = new FakeAgent();
  const bot = new TelegramBot({
    api,
    agent,
    allowedUserIds: new Set(["99"]),
    privateOnly: true,
    pollTimeoutSeconds: 1,
  });

  await bot.handleUpdate({
    update_id: 1,
    message: message(10, 42, "private", "cek router"),
  });

  assert.equal(agent.replyCalls, 0);
  assert.match(api.sent[0]?.text ?? "", /Akses ditolak/);
  assert.match(api.sent[0]?.text ?? "", /42/);
});

test("authorized messages receive agent output", async () => {
  const api = new FakeTelegramApi();
  const agent = new FakeAgent();
  const bot = new TelegramBot({
    api,
    agent,
    allowedUserIds: new Set(["42"]),
    privateOnly: true,
    pollTimeoutSeconds: 1,
  });

  await bot.handleUpdate({
    update_id: 1,
    message: message(10, 42, "private", "cek router"),
  });

  assert.equal(agent.replyCalls, 1);
  assert.equal(api.sent.at(-1)?.text, "Router sehat.");
});

test("typing indicator is refreshed while Codex is working", async () => {
  const api = new FakeTelegramApi();
  const agent = new SlowFakeAgent();
  const bot = new TelegramBot({
    api,
    agent,
    allowedUserIds: new Set(["42"]),
    privateOnly: true,
    pollTimeoutSeconds: 1,
    typingRefreshMs: 10,
  });

  await bot.handleUpdate({
    update_id: 1,
    message: message(10, 42, "private", "cek router"),
  });

  assert.ok(api.chatActions >= 2);
});

test("agent keeps the Codex thread per Telegram chat", async () => {
  const runner = new FakeCodexRunner();
  const agent = new CodexTelegramAgent({
    runner,
    writeEnabled: false,
    pendingChangeTtlMs: 60_000,
  });

  assert.equal((await agent.reply(10, "42", "first")).text, "answer-1");
  assert.equal((await agent.reply(10, "42", "second")).text, "answer-2");
  assert.equal(runner.threadIds[0], undefined);
  assert.equal(runner.threadIds[1], "thread-1");

  agent.reset(10);
  await agent.reply(10, "42", "third");
  assert.equal(runner.threadIds[2], undefined);
});

function message(
  chatId: number,
  userId: number,
  type: "private" | "group",
  text: string,
): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: chatId, type },
    from: { id: userId, first_name: "Tester" },
    text,
  };
}

class FakeAgent implements TelegramAgentService {
  replyCalls = 0;

  async reply(): Promise<AgentReply> {
    this.replyCalls += 1;
    return { text: "Router sehat.", pendingChanges: [] };
  }

  reset(): void {}

  async confirm(): Promise<ChangeExecutionResult> {
    return { ok: false, reason: "not_found", completed: 0, results: [] };
  }

  cancel(): PendingLookup {
    return { ok: false, reason: "not_found" };
  }
}

class SlowFakeAgent extends FakeAgent {
  override async reply(): Promise<AgentReply> {
    await new Promise((resolve) => setTimeout(resolve, 35));
    return super.reply();
  }
}

class FakeCodexRunner implements CodexRunner {
  readonly threadIds: Array<string | undefined> = [];
  #sequence = 0;

  async run(_prompt: string, threadId?: string): Promise<CodexRunResult> {
    this.threadIds.push(threadId);
    this.#sequence += 1;
    return {
      threadId: `thread-${this.#sequence}`,
      finalResponse: JSON.stringify({
        message: `answer-${this.#sequence}`,
        changes: [],
      }),
    };
  }
}

class FakeTelegramApi {
  sent: Array<{ chatId: number; text: string }> = [];
  chatActions = 0;

  async deleteWebhook(): Promise<void> {}
  async getUpdates(): Promise<[]> { return []; }

  async sendMessage(chatId: number, text: string): Promise<TelegramMessage> {
    this.sent.push({ chatId, text });
    return message(chatId, 0, "private", text);
  }

  async sendChatAction(): Promise<void> { this.chatActions += 1; }
  async answerCallbackQuery(): Promise<void> {}
  async clearInlineKeyboard(): Promise<void> {}
}
