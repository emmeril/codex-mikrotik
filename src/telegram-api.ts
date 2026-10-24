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
  type: "bold";
  offset: number;
  length: number;
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

export function splitTelegramText(text: string, maximum = 4_000): string[] {
  if (text.length <= maximum) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maximum) {
    const candidate = remaining.slice(0, maximum + 1);
    const newline = candidate.lastIndexOf("\n");
    const space = candidate.lastIndexOf(" ");
    const splitAt = newline > maximum / 2
      ? newline
      : space > maximum / 2
        ? space
        : maximum;
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
