import { setTimeout as delay } from "node:timers/promises";
import type {
  InlineKeyboardMarkup,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
} from "./telegram-api.js";
import { splitTelegramText, TelegramApi } from "./telegram-api.js";
import type {
  ChangeExecutionResult,
  PendingChangePlan,
  PendingLookup,
  TelegramAgentService,
} from "./telegram-agent.js";

const helpText = `Kirim pertanyaan biasa tentang MikroTik, misalnya:

• Cek versi RouterOS dan resource router
• Interface mana yang sedang down?
• Tampilkan DHCP lease aktif
• Periksa firewall yang disabled
• Tambahkan address 10.10.10.1/24 ke ether3

Perubahan konfigurasi selalu ditampilkan dulu dan hanya berjalan setelah tombol konfirmasi ditekan.

Perintah:
/new - mulai percakapan baru
/whoami - tampilkan Telegram user ID
/help - bantuan`;

interface TelegramBotApi {
  deleteWebhook(): Promise<void>;
  getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]>;
  sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<TelegramMessage>;
  sendChatAction(chatId: number, action: "typing"): Promise<void>;
  answerCallbackQuery(id: string, text?: string, showAlert?: boolean): Promise<void>;
  clearInlineKeyboard(chatId: number, messageId: number): Promise<void>;
}

export class TelegramBot {
  readonly #api: TelegramBotApi;
  readonly #agent: TelegramAgentService;
  readonly #allowedUserIds: ReadonlySet<string>;
  readonly #privateOnly: boolean;
  readonly #pollTimeoutSeconds: number;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: {
    api: TelegramBotApi;
    agent: TelegramAgentService;
    allowedUserIds: ReadonlySet<string>;
    privateOnly: boolean;
    pollTimeoutSeconds: number;
  }) {
    this.#api = options.api;
    this.#agent = options.agent;
    this.#allowedUserIds = options.allowedUserIds;
    this.#privateOnly = options.privateOnly;
    this.#pollTimeoutSeconds = options.pollTimeoutSeconds;
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.#api.deleteWebhook();
    let offset = 0;

    while (!signal.aborted) {
      try {
        const updates = await this.#api.getUpdates(offset, this.#pollTimeoutSeconds);
        for (const update of updates) offset = Math.max(offset, update.update_id + 1);
        await Promise.all(updates.map((update) => this.#enqueue(update)));
      } catch (error) {
        if (signal.aborted) break;
        console.error("Telegram polling error:", error instanceof Error ? error.message : error);
        await delay(1_000, undefined, { signal }).catch(() => undefined);
      }
    }
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.#handleCallback(update.callback_query);
      return;
    }
    if (update.message) await this.#handleMessage(update.message);
  }

  async #handleMessage(message: TelegramMessage): Promise<void> {
    const text = message.text?.trim();
    const user = message.from;
    if (!text || !user) return;

    const userId = String(user.id);
    if (commandName(text) === "/whoami") {
      await this.#sendText(
        message.chat.id,
        `Telegram user ID: ${userId}\nChat ID: ${message.chat.id}`,
      );
      return;
    }
    if (this.#privateOnly && message.chat.type !== "private") {
      await this.#sendText(message.chat.id, "Bot ini hanya menerima perintah melalui chat pribadi.");
      return;
    }
    if (!this.#allowedUserIds.has(userId)) {
      await this.#sendText(
        message.chat.id,
        `Akses ditolak. Telegram user ID Anda: ${userId}. Tambahkan ID ini ke TELEGRAM_ALLOWED_USER_IDS lalu restart bot.`,
      );
      return;
    }

    const command = commandName(text);
    if (command === "/start" || command === "/help") {
      await this.#sendText(message.chat.id, helpText);
      return;
    }
    if (command === "/new") {
      this.#agent.reset(message.chat.id);
      await this.#sendText(message.chat.id, "Konteks percakapan sudah dihapus. Silakan mulai pertanyaan baru.");
      return;
    }

    await this.#api.sendChatAction(message.chat.id, "typing").catch(() => undefined);
    try {
      const reply = await this.#agent.reply(message.chat.id, userId, text);
      await this.#sendText(message.chat.id, reply.text);
      for (const plan of reply.pendingChanges) {
        await this.#sendPlan(plan);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.#sendText(message.chat.id, `Permintaan gagal: ${detail}`);
    }
  }

  async #handleCallback(query: TelegramCallbackQuery): Promise<void> {
    const message = query.message;
    const match = /^(confirm|cancel):([a-f0-9]{12})$/.exec(query.data ?? "");
    if (!message || !match) {
      await this.#api.answerCallbackQuery(query.id, "Konfirmasi tidak valid.", true);
      return;
    }

    const userId = String(query.from.id);
    if (!this.#allowedUserIds.has(userId)) {
      await this.#api.answerCallbackQuery(query.id, "Anda tidak diizinkan.", true);
      return;
    }
    if (this.#privateOnly && message.chat.type !== "private") {
      await this.#api.answerCallbackQuery(query.id, "Gunakan chat pribadi.", true);
      return;
    }

    const action = match[1];
    const id = match[2];
    if (!action || !id) return;

    if (action === "cancel") {
      const result = this.#agent.cancel(message.chat.id, userId, id);
      await this.#api.answerCallbackQuery(query.id, callbackStatus(result, "Perubahan dibatalkan."), !result.ok);
      if (result.ok) {
        await this.#api.clearInlineKeyboard(message.chat.id, message.message_id).catch(() => undefined);
        await this.#sendText(message.chat.id, `Dibatalkan: ${result.plan.summary}`);
      }
      return;
    }

    await this.#api.answerCallbackQuery(query.id, "Menjalankan perubahan...");
    await this.#api.clearInlineKeyboard(message.chat.id, message.message_id).catch(() => undefined);
    const result = await this.#agent.confirm(message.chat.id, userId, id);
    await this.#sendText(message.chat.id, formatExecutionResult(result));
  }

  async #sendPlan(plan: PendingChangePlan): Promise<void> {
    const seconds = Math.max(1, Math.round((plan.expiresAt - Date.now()) / 1_000));
    const operations = plan.operations.map((operation, index) =>
      `${index + 1}. ${operation.command}\n${JSON.stringify(operation.attributes, null, 2)}`
    ).join("\n\n");
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[
        { text: "Jalankan", callback_data: `confirm:${plan.id}` },
        { text: "Batalkan", callback_data: `cancel:${plan.id}` },
      ]],
    };
    await this.#sendText(
      plan.chatId,
      `MENUNGGU KONFIRMASI\n\n${plan.summary}\n\n${operations}\n\nBerlaku ${seconds} detik. Periksa command dan attribute sebelum menjalankan.`,
      keyboard,
    );
  }

  async #sendText(
    chatId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    const chunks = splitTelegramText(text);
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      await this.#api.sendMessage(chatId, chunk, isLast ? replyMarkup : undefined);
    }
  }

  #enqueue(update: TelegramUpdate): Promise<void> {
    const key = String(
      update.message?.chat.id
      ?? update.callback_query?.message?.chat.id
      ?? update.update_id,
    );
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.handleUpdate(update))
      .finally(() => {
        if (this.#queues.get(key) === current) this.#queues.delete(key);
      });
    this.#queues.set(key, current);
    return current;
  }
}

export function createTelegramApi(token: string): TelegramApi {
  return new TelegramApi(token);
}

function commandName(text: string): string | undefined {
  const first = text.split(/\s+/, 1)[0]?.toLowerCase();
  return first?.replace(/@[^\s]+$/, "");
}

function callbackStatus(result: PendingLookup, success: string): string {
  if (result.ok) return success;
  if (result.reason === "expired") return "Konfirmasi sudah kedaluwarsa.";
  if (result.reason === "forbidden") return "Konfirmasi ini milik pengguna lain.";
  return "Konfirmasi tidak ditemukan atau sudah dipakai.";
}

function formatExecutionResult(result: ChangeExecutionResult): string {
  if (result.ok && result.plan) {
    return `BERHASIL\n${result.plan.summary}\n${result.completed} operasi selesai.`;
  }
  if (result.reason === "expired") return "GAGAL\nKonfirmasi sudah kedaluwarsa. Minta bot menyiapkan perubahan lagi.";
  if (result.reason === "forbidden") return "GAGAL\nKonfirmasi ini milik pengguna atau chat lain.";
  if (result.reason === "not_found") return "GAGAL\nKonfirmasi tidak ditemukan atau sudah pernah dipakai.";
  const summary = result.plan?.summary ?? "Perubahan konfigurasi";
  return `GAGAL\n${summary}\n${result.completed} operasi sudah selesai sebelum kegagalan. Operasi berikutnya dihentikan.\nError: ${result.error ?? "tidak diketahui"}`;
}
