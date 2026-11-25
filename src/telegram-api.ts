export interface TelegramUser {
  id: number;
  username?: string;
  first_name: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TelegramMessageEntity {
  type: "bold" | "code" | "pre";
  offset: number;
  length: number;
}

export interface TelegramText {
  text: string;
  entities: TelegramMessageEntity[];
}

export interface TelegramBotCommand {
  command: string;
  description: string;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export class TelegramApi {
  readonly #baseUrl: string;

  constructor(token: string) {
    this.#baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async deleteWebhook(): Promise<void> {
    await this.#call("deleteWebhook", { drop_pending_updates: false });
  }

  async setMyCommands(chatId: number, commands: TelegramBotCommand[]): Promise<void> {
    await this.#call("setMyCommands", { scope: { type: "chat", chat_id: chatId }, commands });
  }

  async getMyCommands(chatId: number): Promise<TelegramBotCommand[]> {
    return this.#call("getMyCommands", { scope: { type: "chat", chat_id: chatId } });
  }

  async getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    return this.#call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message", "callback_query"],
    }, (timeout + 10) * 1_000);
  }

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: InlineKeyboardMarkup,
    entities?: TelegramMessageEntity[],
  ): Promise<TelegramMessage> {
    return this.#call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      ...(entities?.length ? { entities } : {}),
    });
  }

  async sendChatAction(chatId: number, action: "typing"): Promise<void> {
    await this.#call("sendChatAction", { chat_id: chatId, action });
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    showAlert = false,
  ): Promise<void> {
    await this.#call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      show_alert: showAlert,
    });
  }

  async clearInlineKeyboard(chatId: number, messageId: number): Promise<void> {
    await this.#call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  async #call<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<T> {
    const response = await fetch(`${this.#baseUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new Error(payload.description || `Telegram API ${method} gagal (${response.status})`);
    }
    return payload.result;
  }
}

export function telegramLiteral(value: string): string {
  return value.replace(/[\\*`]/g, "\\$&");
}

export function formatTelegramText(text: string): TelegramText {
  const result: TelegramText = { text: "", entities: [] };
  const pattern = /^```[\w+-]*[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?=\r?$)|\\([\\*`])|\*\*((?:\\[\\*`]|[^*\\\r\n]|\*(?!\*))+?)\*\*|(?<!`)`([^`\r\n]+)`(?!`)/gm;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const [raw, block, escaped, bold, code] = match;
    result.text += text.slice(cursor, match.index);
    if (escaped !== undefined) {
      result.text += escaped;
    } else {
      const content = block?.replace(/\r?\n$/, "") ?? bold?.replace(/\\([\\*`])/g, "$1") ?? code;
      if (!content?.trim()) {
        result.text += raw;
      } else {
        const type = block !== undefined ? "pre" : bold !== undefined ? "bold" : "code";
        result.entities.push({ type, offset: result.text.length, length: content.length });
        result.text += content;
      }
    }
    cursor = match.index + raw.length;
  }
  return { text: result.text + text.slice(cursor), entities: result.entities };
}

export function splitTelegramText(text: string, maximum = 4_000): string[] {
  return textRanges(text, maximum).map(([start, end]) => text.slice(start, end));
}

export function splitFormattedTelegramText(message: TelegramText, maximum = 4_000): TelegramText[] {
  return textRanges(message.text, maximum).map(([start, end]) => ({
    text: message.text.slice(start, end),
    entities: message.entities.flatMap((entity) => {
      const left = Math.max(start, entity.offset);
      const right = Math.min(end, entity.offset + entity.length);
      return left < right ? [{ ...entity, offset: left - start, length: right - left }] : [];
    }),
  }));
}

export async function sendTelegramText(
  api: Pick<TelegramApi, "sendMessage">,
  chatId: number,
  message: string | TelegramText,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<void> {
  const formatted = typeof message === "string" ? formatTelegramText(message) : message;
  const chunks = splitFormattedTelegramText(formatted).filter((chunk) => chunk.text.trim());
  for (const [index, chunk] of chunks.entries()) {
    await api.sendMessage(chatId, chunk.text, index === chunks.length - 1 ? replyMarkup : undefined, chunk.entities);
  }
}

function textRanges(text: string, maximum: number): [number, number][] {
  if (!Number.isInteger(maximum) || maximum < 2) throw new Error("Batas pesan Telegram tidak valid");
  const ranges: [number, number][] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maximum, text.length);
    if (end < text.length) {
      const segment = text.slice(start, end);
      const breaks = [segment.lastIndexOf("\n\n") + 2, segment.lastIndexOf("\n") + 1, segment.lastIndexOf(" ") + 1];
      const preferred = breaks.find((point) => point > maximum / 2);
      if (preferred) end = start + preferred;
      if (text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff
        && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
    }
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

const wibClock = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Jakarta",
});

export function telegramTime(iso: string): string {
  return wibClock.format(new Date(iso)) + " WIB";
}
