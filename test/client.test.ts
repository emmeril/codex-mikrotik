import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";
import { RouterOsClient } from "../src/client.js";
import type { RouterOsConfig } from "../src/config.js";
import { encodeSentence, SentenceReader } from "../src/protocol.js";

test("logs in with modern RouterOS and executes a command", async (context) => {
  const server = await mockServer(async (socket, reader) => {
    assert.deepEqual(await reader.readSentence(), [
      "/login",
      "=name=codex",
      "=password=secret",
    ]);
    socket.write(encodeSentence(["!done"]));
    assert.deepEqual(await reader.readSentence(), ["/system/identity/print"]);
    socket.write(encodeSentence(["!re", "=name=lab-router"]));
    socket.write(encodeSentence(["!done"]));
  });
  context.after(() => server.close());

  const client = new RouterOsClient(configFor(server));
  await client.connect();
  assert.deepEqual(await client.command("/system/identity/print"), [
    { name: "lab-router" },
  ]);
  client.close();
});

test("falls back to pre-6.43 challenge login", async (context) => {
  const challenge = "00112233445566778899aabbccddeeff";
  const expectedResponse =
    "00" +
    createHash("md5")
      .update(Buffer.from([0]))
      .update("secret", "utf8")
      .update(Buffer.from(challenge, "hex"))
      .digest("hex");

  const server = await mockServer(async (socket, reader) => {
    await reader.readSentence();
    socket.write(encodeSentence(["!trap", "=message=unknown parameter"]));
    assert.deepEqual(await reader.readSentence(), ["/login"]);
    socket.write(encodeSentence(["!done", `=ret=${challenge}`]));
    assert.deepEqual(await reader.readSentence(), [
      "/login",
      "=name=codex",
      `=response=${expectedResponse}`,
    ]);
    socket.write(encodeSentence(["!done"]));
    assert.deepEqual(await reader.readSentence(), ["/system/resource/print"]);
    socket.write(encodeSentence(["!re", "=version=6.42.12"]));
    socket.write(encodeSentence(["!done"]));
  });
  context.after(() => server.close());

  const client = new RouterOsClient(configFor(server));
  await client.connect();
  assert.deepEqual(await client.command("/system/resource/print"), [
    { version: "6.42.12" },
  ]);
  client.close();
});

async function mockServer(
  handler: (socket: Socket, reader: SentenceReader) => Promise<void>,
): Promise<Server> {
  const server = createServer((socket) => {
    const reader = new SentenceReader(socket);
    handler(socket, reader).catch((error: unknown) => socket.destroy(error as Error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function configFor(server: Server): RouterOsConfig {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server has no port");
  return {
    host: "127.0.0.1",
    port: address.port,
    username: "codex",
    password: "secret",
    tls: false,
    tlsRejectUnauthorized: true,
    connectTimeoutMs: 1_000,
    commandTimeoutMs: 1_000,
    maxRows: 100,
    writeEnabled: false,
    sensitiveReadEnabled: false,
  };
}
