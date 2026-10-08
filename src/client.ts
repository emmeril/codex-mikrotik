import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";
import type { RouterOsConfig } from "./config.js";
import { encodeSentence, SentenceReader } from "./protocol.js";

export type RouterOsRecord = Record<string, string>;

export interface CommandOptions {
  attributes?: Record<string, string | number | boolean>;
  queries?: string[];
  proplist?: string[];
  limit?: number;
}

export class RouterOsError extends Error {
  constructor(
    message: string,
    readonly category?: string,
  ) {
    super(message);
    this.name = "RouterOsError";
  }
}

interface Reply {
  rows: RouterOsRecord[];
  done: RouterOsRecord;
}

export class RouterOsClient {
  private socket: Socket | TLSSocket | undefined;
  private reader: SentenceReader | undefined;

  constructor(private readonly config: RouterOsConfig) {}

  async connect(): Promise<void> {
    const socket = this.config.tls
      ? connectTls({
          host: this.config.host,
          port: this.config.port,
          rejectUnauthorized: this.config.tlsRejectUnauthorized,
          ...(this.config.tlsServerName
            ? { servername: this.config.tlsServerName }
            : {}),
          ...(this.config.tlsCa ? { ca: this.config.tlsCa } : {}),
        })
      : createConnection({ host: this.config.host, port: this.config.port });

    await this.waitForConnection(socket);
    socket.setKeepAlive(true, 10_000);
    socket.setNoDelay(true);
    this.socket = socket;
    this.reader = new SentenceReader(socket);
    await this.login();
  }

  async command(command: string, options: CommandOptions = {}): Promise<RouterOsRecord[]> {
    const words = [command];
    for (const [key, value] of Object.entries(options.attributes ?? {})) {
      words.push(`=${key}=${formatValue(value)}`);
    }
    if (options.proplist?.length) {
      words.push(`=.proplist=${options.proplist.join(",")}`);
    }
    words.push(...(options.queries ?? []));
    return (await this.exchange(words, options.limit)).rows;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.reader = undefined;
  }

  private async login(): Promise<void> {
    let first: Reply;
    try {
      first = await this.exchange([
        "/login",
        `=name=${this.config.username}`,
        `=password=${this.config.password}`,
      ]);
    } catch (modernLoginError) {
      const legacy = await this.exchange(["/login"]).catch(() => {
        throw modernLoginError;
      });
      if (!legacy.done.ret) throw modernLoginError;
      first = legacy;
    }
    const challenge = first.done.ret;
    if (!challenge) return;

    const response = createHash("md5")
      .update(Buffer.from([0]))
      .update(this.config.password, "utf8")
      .update(Buffer.from(challenge, "hex"))
      .digest("hex");
    await this.exchange([
      "/login",
      `=name=${this.config.username}`,
      `=response=00${response}`,
    ]);
  }

  private async exchange(words: string[], limit?: number): Promise<Reply> {
    if (!this.socket || !this.reader) throw new Error("Client belum terhubung");
    await write(this.socket, encodeSentence(words));

    const rows: RouterOsRecord[] = [];
    const rowLimit = Math.min(limit ?? this.config.maxRows, this.config.maxRows);
    while (true) {
      const sentence = await withTimeout(
        this.reader.readSentence(),
        this.config.commandTimeoutMs,
        "Perintah RouterOS melewati batas waktu",
      );
      const [type, ...parts] = sentence;
      const attributes = parseAttributes(parts);
      if (type === "!re") {
        if (rows.length < rowLimit) rows.push(attributes);
        continue;
      }
      if (type === "!done") return { rows, done: attributes };
      if (type === "!trap" || type === "!fatal") {
        throw new RouterOsError(
          attributes.message ?? `RouterOS mengembalikan ${type}`,
          attributes.category,
        );
      }
      throw new Error(`Jenis reply RouterOS tidak dikenal: ${type ?? "kosong"}`);
    }
  }

  private async waitForConnection(socket: Socket | TLSSocket): Promise<void> {
    const event = this.config.tls ? "secureConnect" : "connect";
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          socket.off(event, onReady);
          socket.off("error", onError);
        };
        socket.once(event, onReady);
        socket.once("error", onError);
      }),
      this.config.connectTimeoutMs,
      `Tidak dapat terhubung ke ${this.config.host}:${this.config.port}`,
    ).catch((error) => {
      socket.destroy();
      throw error;
    });
  }
}

function parseAttributes(words: string[]): RouterOsRecord {
  const result: RouterOsRecord = {};
  for (const word of words) {
    if (!word.startsWith("=")) continue;
    const separator = word.indexOf("=", 1);
    if (separator < 0) continue;
    result[word.slice(1, separator)] = word.slice(separator + 1);
  }
  return result;
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function write(socket: Socket | TLSSocket, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
