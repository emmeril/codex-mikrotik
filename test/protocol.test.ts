import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { encodeLength, encodeSentence, SentenceReader } from "../src/protocol.js";

test("encodes RouterOS length boundaries", () => {
  assert.deepEqual([...encodeLength(0x7f)], [0x7f]);
  assert.deepEqual([...encodeLength(0x80)], [0x80, 0x80]);
  assert.deepEqual([...encodeLength(0x3fff)], [0xbf, 0xff]);
  assert.deepEqual([...encodeLength(0x4000)], [0xc0, 0x40, 0x00]);
  assert.deepEqual([...encodeLength(0x20_0000)], [0xe0, 0x20, 0x00, 0x00]);
  assert.deepEqual([...encodeLength(0x1000_0000)], [0xf0, 0x10, 0x00, 0x00, 0x00]);
});

test("reads a sentence split across network chunks", async () => {
  const stream = new PassThrough();
  const reader = new SentenceReader(stream);
  const encoded = encodeSentence(["!re", "=name=ether1", "=running=true"]);

  for (const byte of encoded) stream.write(Buffer.from([byte]));

  assert.deepEqual(await reader.readSentence(), [
    "!re",
    "=name=ether1",
    "=running=true",
  ]);
  stream.destroy();
});
