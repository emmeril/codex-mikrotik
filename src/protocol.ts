import type { Duplex } from "node:stream";

const MAX_WORD_BYTES = 16 * 1024 * 1024;

export function encodeLength(length: number): Buffer {
  if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) {
    throw new Error(`Panjang word RouterOS tidak valid: ${length}`);
  }
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) {
    return Buffer.from([(length >> 8) | 0x80, length & 0xff]);
  }
  if (length < 0x20_0000) {
    return Buffer.from([
      (length >> 16) | 0xc0,
      (length >> 8) & 0xff,
      length & 0xff,
    ]);
  }
  if (length < 0x1000_0000) {
    return Buffer.from([
      (length >> 24) | 0xe0,
      (length >> 16) & 0xff,
      (length >> 8) & 0xff,
      length & 0xff,
    ]);
  }
  const encoded = Buffer.allocUnsafe(5);
  encoded[0] = 0xf0;
  encoded.writeUInt32BE(length, 1);
  return encoded;
}

export function encodeSentence(words: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const word of words) {
    if (word.includes("\0")) throw new Error("Word RouterOS tidak boleh berisi NUL");
    const body = Buffer.from(word, "utf8");
    chunks.push(encodeLength(body.length), body);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

export class SentenceReader {
  private buffer = Buffer.alloc(0);
  private failure?: Error;
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(private readonly stream: Duplex) {
    stream.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.buffer = Buffer.concat([this.buffer, data]);
      this.wake();
    });
    stream.on("error", (error) => this.fail(error));
    stream.on("end", () => this.fail(new Error("Koneksi RouterOS ditutup")));
  }

  async readSentence(): Promise<string[]> {
    const words: string[] = [];
    while (true) {
      const length = await this.readLength();
      if (length === 0) return words;
      if (length > MAX_WORD_BYTES) {
        throw new Error(`Word RouterOS terlalu besar: ${length} byte`);
      }
      words.push((await this.readBytes(length)).toString("utf8"));
    }
  }

  private async readLength(): Promise<number> {
    const first = (await this.readBytes(1))[0]!;
    if ((first & 0x80) === 0) return first;
    if ((first & 0xc0) === 0x80) {
      const rest = await this.readBytes(1);
      return ((first & 0x3f) << 8) | rest[0]!;
    }
    if ((first & 0xe0) === 0xc0) {
      const rest = await this.readBytes(2);
      return ((first & 0x1f) << 16) | (rest[0]! << 8) | rest[1]!;
    }
    if ((first & 0xf0) === 0xe0) {
      const rest = await this.readBytes(3);
      return (
        ((first & 0x0f) << 24) |
        (rest[0]! << 16) |
        (rest[1]! << 8) |
        rest[2]!
      );
    }
    if (first === 0xf0) return (await this.readBytes(4)).readUInt32BE(0);
    throw new Error(`Prefix panjang RouterOS tidak dikenal: 0x${first.toString(16)}`);
  }

  private async readBytes(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }
    const result = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return result;
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}
