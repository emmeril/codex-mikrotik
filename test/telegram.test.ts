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
import {
  formatTelegramText,
  splitFormattedTelegramText,
  splitTelegramText,
  telegramLiteral,
  type InlineKeyboardMarkup,
  type TelegramBotCommand,
  type TelegramMessage,
  type TelegramMessageEntity,
} from "../src/telegram-api.js";
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

test("Telegram formatting survives message splits and keeps code and escaped values literal", () => {
  const bold = "🟢".repeat(15);
  const literal = "**raw** `keep` \\";
  const block = '{"comment":"**raw** `keep`"}';
  const rendered = formatTelegramText([`~**${bold}**`, telegramLiteral(literal), "```json", block, "```", ""].join("\n"));
  const chunks = splitFormattedTelegramText(rendered, 20);

  assert.equal(chunks.map((chunk) => chunk.text).join(""), `~${bold}\n${literal}\n${block}\n`);
  const parts = (type: TelegramMessageEntity["type"]) => chunks.flatMap((chunk) => chunk.entities
    .filter((entity) => entity.type === type).map(({ offset, length }) => chunk.text.slice(offset, offset + length))).join("");
  assert.equal(parts("bold"), bold);
  assert.equal(parts("pre"), block);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 20 && !/[\ud800-\udbff]$/.test(chunk.text)));
});

test("change preview keeps exact attributes and places its confirmation keyboard after all chunks", async () => {
  const api = new FakeTelegramApi();
  const store = new PendingChangeStore(60_000);
  const attributes = { ".id": "*1", comment: "**literal** `value`".repeat(390) };
  const plan = store.create(42, "42", "Ubah comment", [{ command: "/interface/set", attributes }]);
  const agent = new class extends FakeAgent {
    override async reply(): Promise<AgentReply> { return { text: "Rencana siap.", pendingChanges: [plan] }; }
  }();
  const bot = new TelegramBot({ api, agent, allowedUserIds: new Set(["42"]), privateOnly: true, pollTimeoutSeconds: 1 });
  await bot.handleUpdate({ update_id: 1, message: message(42, 42, "private", "ubah comment") });
  const preview = api.sent.slice(1);
  const code = preview.flatMap((chunk) => (chunk.entities ?? []).filter((entity) => entity.type === "pre")
    .map(({ offset, length }) => chunk.text.slice(offset, offset + length))).join("");
  assert.equal(code, `1. /interface/set\n${JSON.stringify(attributes, null, 2)}`);
  assert.ok(preview.length > 1);
  assert.ok(preview.slice(0, -1).every((chunk) => !chunk.replyMarkup));
  assert.equal(preview.at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data, `confirm:${plan.id}`);
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

test("Markdown bold is rendered as a Telegram entity", async () => {
  const api = new FakeTelegramApi();
  const agent = new FakeAgent("Saat ini ada **131 sesi pengguna hotspot aktif** di router Ro-Emmeril.");
  const bot = new TelegramBot({
    api,
    agent,
    allowedUserIds: new Set(["42"]),
    privateOnly: true,
    pollTimeoutSeconds: 1,
  });

  await bot.handleUpdate({
    update_id: 1,
    message: message(10, 42, "private", "berapa user aktif?"),
  });

  assert.equal(
    api.sent[0]?.text,
    "Saat ini ada 131 sesi pengguna hotspot aktif di router Ro-Emmeril.",
  );
  assert.deepEqual(api.sent[0]?.entities, [{
    type: "bold",
    offset: 13,
    length: "131 sesi pengguna hotspot aktif".length,
  }]);
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

test("automatic NOC diagnosis rejects changes even when Telegram writes are enabled", async () => {
  const pending = new PendingChangeStore(60_000);
  const create = test.mock.method(pending, "create");
  try {
    const agent = new CodexTelegramAgent({
      runner: {
        run: async (_prompt, threadId) => {
          assert.equal(threadId, undefined);
          return {
            threadId: "noc",
            finalResponse: JSON.stringify({
              message: "Rencana perubahan",
              changes: [{ summary: "Disable interface", operations: [{ command: "/interface/disable", attributes: [] }] }],
            }),
          };
        },
      },
      writeEnabled: true,
      pendingChangeTtlMs: 60_000,
      pendingStore: pending,
    });
    await assert.rejects(agent.diagnoseNocIncident("Ro-Test", {
      observedAt: "2026-01-01T00:00:00Z", readings: [],
    }), /hanya membaca/);
    assert.equal(create.mock.callCount(), 0);
  } finally {
    create.mock.restore();
  }
});

test("NOC status only appears in the configured recipient's private chat", async () => {
  const api = new FakeTelegramApi();
  const agent = new FakeAgent();
  const operations: string[] = [];
  const bot = new TelegramBot({
    api, agent, allowedUserIds: new Set(["42", "43"]), privateOnly: false,
    pollTimeoutSeconds: 1, noc: {
      recipient: 42, status: () => "Sampel NOC",
      command: async (command, argument) => { operations.push(`${command} ${argument}`); return "Draf operator"; },
    },
  });
  await bot.handleUpdate({ update_id: 1, message: message(-10, 42, "group", "/noc") });
  await bot.handleUpdate({ update_id: 2, message: message(43, 43, "private", "/noc") });
  await bot.handleUpdate({ update_id: 3, message: message(42, 42, "private", "/noc") });
  assert.match(api.sent[0]!.text, /tidak tersedia/);
  assert.match(api.sent[1]!.text, /tidak tersedia/);
  assert.equal(api.sent[2]!.text, "Sampel NOC");
  await bot.handleUpdate({ update_id: 4, message: message(-10, 42, "group", "/noc_customer NOC-1") });
  await bot.handleUpdate({ update_id: 5, message: message(43, 43, "private", "/noc_ack NOC-1") });
  await bot.handleUpdate({ update_id: 6, message: message(42, 42, "private", "/noc_customer NOC-1") });
  assert.match(api.sent[3]!.text, /tidak tersedia/);
  assert.match(api.sent[4]!.text, /tidak tersedia/);
  assert.equal(api.sent[5]!.text, "Draf operator");
  assert.deepEqual(operations, ["/noc_customer NOC-1"]);
  assert.equal(agent.replyCalls, 0);
});

test("bot startup registers supported commands only for an allowlisted NOC recipient", async () => {
  for (const allowed of [true, false]) {
    const controller = new AbortController();
    const menus: { chatId: number; commands: TelegramBotCommand[] }[] = [];
    const api = new class extends FakeTelegramApi {
      override async getUpdates(): Promise<[]> {
        controller.abort();
        return [];
      }
      async setMyCommands(chatId: number, commands: TelegramBotCommand[]): Promise<void> {
        menus.push({ chatId, commands });
      }
    }();
    const bot = new TelegramBot({
      api, agent: new FakeAgent(), allowedUserIds: new Set(allowed ? ["42", "43"] : ["43"]), privateOnly: true,
      pollTimeoutSeconds: 1, noc: {
        recipient: 42, status: () => "Status", command: async () => "NOC",
      },
    });
    await bot.run(controller.signal);
    if (!allowed) {
      assert.deepEqual(menus, []);
      continue;
    }
    assert.deepEqual(menus.map((menu) => menu.chatId), [42]);
    assert.deepEqual(menus[0]?.commands.map((item) => item.command), [
      "noc", "noc_inventory", "noc_report", "noc_incidents", "noc_ack", "noc_escalate", "noc_customer",
      "start", "help", "new", "whoami",
    ]);
  }
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

  constructor(readonly response = "Router sehat.") {}

  async reply(): Promise<AgentReply> {
    this.replyCalls += 1;
    return { text: this.response, pendingChanges: [] };
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
  sent: Array<{
    chatId: number;
    text: string;
    entities?: TelegramMessageEntity[];
    replyMarkup?: InlineKeyboardMarkup;
  }> = [];
  chatActions = 0;

  async deleteWebhook(): Promise<void> {}
  async getUpdates(): Promise<[]> { return []; }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    entities?: TelegramMessageEntity[],
  ): Promise<TelegramMessage> {
    this.sent.push({ chatId, text, ...(entities?.length ? { entities } : {}), ...(replyMarkup ? { replyMarkup } : {}) });
    return message(chatId, 0, "private", text);
  }

  async sendChatAction(): Promise<void> { this.chatActions += 1; }
  async answerCallbackQuery(): Promise<void> {}
  async clearInlineKeyboard(): Promise<void> {}
}
