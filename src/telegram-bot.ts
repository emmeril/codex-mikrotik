import { setTimeout as delay } from "node:timers/promises";
import type {
  InlineKeyboardMarkup,
  TelegramBotCommand,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramText,
  TelegramUpdate,
} from "./telegram-api.js";
import { sendTelegramText, TelegramApi, telegramLiteral } from "./telegram-api.js";
import type {
  ChangeExecutionResult,
  PendingChangePlan,
  PendingLookup,
  TelegramAgentService,
} from "./telegram-agent.js";

const helpIntro = `**Bantuan MikroTik**
Tulis pertanyaan seperti “Kenapa ISP-2 sering putus?” atau “Cek pemakaian bandwidth saat ini.”`;

const CHAT_COMMANDS = {
  "/start": "Mulai menggunakan bot",
  "/help": "Buka bantuan",
  "/new": "Mulai percakapan baru",
  "/whoami": "Lihat ID Telegram dan chat",
} as const;

const helpChat = [
  "**Percakapan dan akses**",
  ...Object.entries(CHAT_COMMANDS).map(([name, description]) => `${name} · ${description}`),
  "",
  "Periksa rencana perubahan sebelum menekan **Jalankan**.",
].join("\n");

const NOC_COMMANDS = {
  "/noc": "Status dari sampel terakhir",
  "/noc_inventory": "Perangkat dan topologi",
  "/noc_report": "Laporan hari ini. Tambahkan 7 untuk tujuh hari.",
  "/noc_incidents": "Insiden terbuka dan pemulihan",
  "/noc_ack": "Tandai insiden sudah diperiksa (sertakan ID)",
  "/noc_escalate": "Buat draf untuk teknisi atau ISP (sertakan ID)",
  "/noc_customer": "Buat draf pelanggan (sertakan ID)",
} as const;

export function nocTelegramMenuCommands(includeOperations = true): TelegramBotCommand[] {
  const noc = Object.entries(NOC_COMMANDS).filter(([command]) => includeOperations || command === "/noc");
  return [...noc, ...Object.entries(CHAT_COMMANDS)]
    .map(([command, description]) => ({ command: command.slice(1), description }));
}

interface TelegramNoc {
  recipient: number;
  status: () => string;
  command?: (command: string, argument: string) => Promise<string | undefined>;
  recordChange?: (completed: number, ok: boolean) => Promise<void>;
}

interface TelegramBotApi {
  deleteWebhook(): Promise<void>;
  setMyCommands?(chatId: number, commands: TelegramBotCommand[]): Promise<void>;
  getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]>;
  sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    entities?: TelegramMessageEntity[],
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
  readonly #typingRefreshMs: number;
  readonly #noc: TelegramNoc | undefined;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: {
    api: TelegramBotApi;
    agent: TelegramAgentService;
    allowedUserIds: ReadonlySet<string>;
    privateOnly: boolean;
    pollTimeoutSeconds: number;
    typingRefreshMs?: number;
    noc?: TelegramNoc;
  }) {
    this.#api = options.api;
    this.#agent = options.agent;
    this.#allowedUserIds = options.allowedUserIds;
    this.#privateOnly = options.privateOnly;
    this.#pollTimeoutSeconds = options.pollTimeoutSeconds;
    this.#typingRefreshMs = options.typingRefreshMs ?? 4_000;
    this.#noc = options.noc;
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.#api.deleteWebhook();
    if (this.#noc && this.#allowedUserIds.has(String(this.#noc.recipient)) && !signal.aborted) {
      const commands = nocTelegramMenuCommands(Boolean(this.#noc.command));
      void this.#api.setMyCommands?.(this.#noc.recipient, commands).catch(() => {
        console.error("Telegram gagal memperbarui menu perintah NOC.");
      });
    }
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
      const sections = [helpIntro];
      if (this.#canViewNoc(message)) {
        const lines = (names: (keyof typeof NOC_COMMANDS)[]) =>
          names.map((name) => `${name} · ${NOC_COMMANDS[name]}`);
        sections.push(["**Cek dan laporan**", ...lines(this.#noc?.command ? ["/noc", "/noc_inventory", "/noc_report"] : ["/noc"])].join("\n"));
        if (this.#noc?.command) sections.push([
          "**Kelola insiden**", ...lines(["/noc_incidents", "/noc_ack", "/noc_escalate", "/noc_customer"]),
          "Tambahkan ID insiden pada perintah akuan atau draf, misalnya /noc_ack NOC-1.",
        ].join("\n"));
      }
      await this.#sendText(message.chat.id, [...sections, helpChat].join("\n\n"));
      return;
    }
    if (command && Object.hasOwn(NOC_COMMANDS, command)) {
      let response: string | undefined;
      if (this.#canViewNoc(message)) {
        const argument = text.replace(/^\S+\s*/, "");
        try {
          response = command === "/noc" ? this.#noc?.status() : await this.#noc?.command?.(command, argument);
        } catch {
          response = "Operasi NOC gagal. Periksa penyimpanan dan log bot.";
        }
      }
      await this.#sendText(message.chat.id, response ?? "Status NOC tidak tersedia di chat ini.");
      return;
    }
    if (command === "/new") {
      this.#agent.reset(message.chat.id);
      await this.#sendText(message.chat.id, "Konteks percakapan sudah dihapus. Silakan mulai pertanyaan baru.");
      return;
    }

    const startedAt = Date.now();
    let outcome = "ok";
    await this.#api.sendChatAction(message.chat.id, "typing").catch(() => undefined);
    const typingTimer = setInterval(() => {
      void this.#api.sendChatAction(message.chat.id, "typing").catch(() => undefined);
    }, this.#typingRefreshMs);
    typingTimer.unref();
    try {
      const reply = await this.#agent.reply(message.chat.id, userId, text);
      await this.#sendText(message.chat.id, reply.text);
      for (const plan of reply.pendingChanges) {
        await this.#sendPlan(plan);
      }
    } catch (error) {
      outcome = "error";
      const detail = error instanceof Error ? error.message : String(error);
      await this.#sendText(message.chat.id, `**Permintaan gagal**\n${telegramLiteral(detail)}`);
    } finally {
      clearInterval(typingTimer);
      console.error(`Telegram request outcome=${outcome} duration_ms=${Date.now() - startedAt}`);
    }
  }

  #canViewNoc(message: TelegramMessage): boolean {
    return this.#noc !== undefined && message.chat.type === "private"
      && message.chat.id === this.#noc.recipient && message.from?.id === this.#noc.recipient;
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
        await this.#sendText(message.chat.id, `**Perubahan dibatalkan**\n${telegramLiteral(result.plan.summary)}`);
      }
      return;
    }

    await this.#api.answerCallbackQuery(query.id, "Menjalankan perubahan...");
    await this.#api.clearInlineKeyboard(message.chat.id, message.message_id).catch(() => undefined);
    const result = await this.#agent.confirm(message.chat.id, userId, id);
    if (result.plan) await this.#noc?.recordChange?.(result.completed, result.ok)
      .catch(() => console.error("NOC gagal mencatat hasil perubahan router."));
    await this.#sendText(message.chat.id, formatExecutionResult(result));
  }

  async #sendPlan(plan: PendingChangePlan): Promise<void> {
    const seconds = Math.max(1, Math.round((plan.expiresAt - Date.now()) / 1_000));
    const operations = plan.operations.map((operation, index) =>
      `${index + 1}. ${operation.command}\n${JSON.stringify(operation.attributes, null, 2)}`
    ).join("\n\n");
    const title = "Tinjau perubahan";
    const intro = `${title}\n${plan.summary}\n\n`;
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [[
        { text: "Jalankan", callback_data: `confirm:${plan.id}` },
        { text: "Batalkan", callback_data: `cancel:${plan.id}` },
      ]],
    };
    await this.#sendText(
      plan.chatId,
      {
        text: `${intro}${operations}\n\nBerlaku ${seconds} detik. Pilih Jalankan jika perintah dan atribut sudah sesuai.`,
        entities: [
          { type: "bold", offset: 0, length: title.length },
          { type: "pre", offset: intro.length, length: operations.length },
        ],
      },
      keyboard,
    );
  }

  async #sendText(
    chatId: number,
    text: string | TelegramText,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<void> {
    await sendTelegramText(this.#api, chatId, text, replyMarkup);
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

export { formatTelegramText } from "./telegram-api.js";

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
    return `**Perintah berhasil dijalankan**\n${telegramLiteral(result.plan.summary)}\n\n${result.completed} operasi selesai.\nPeriksa kembali status yang ingin diperbaiki.`;
  }
  if (result.reason === "expired") return "**Konfirmasi kedaluwarsa**\nMinta bot menyiapkan perubahan lagi.";
  if (result.reason === "forbidden") return "**Konfirmasi ditolak**\nKonfirmasi ini terikat ke pengguna atau chat lain.";
  if (result.reason === "not_found") return "**Konfirmasi tidak tersedia**\nKonfirmasi tidak ditemukan atau sudah pernah dipakai.";
  const summary = telegramLiteral(result.plan?.summary ?? "Perubahan konfigurasi");
  const error = telegramLiteral(result.error ?? "Penyebab belum diketahui.");
  return `**Perubahan dihentikan**\n${summary}\n\n${result.completed} operasi selesai sebelum kegagalan.\n${error}\n\nPeriksa kondisi router sebelum mencoba lagi.`;
}
