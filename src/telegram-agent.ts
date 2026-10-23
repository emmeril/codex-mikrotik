import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { runWriteCommand, validateWriteOperation } from "./tools.js";

export type RouterOsScalar = string | number | boolean;

export interface ChangeOperation {
  command: string;
  attributes: Record<string, RouterOsScalar>;
}

export interface PendingChangePlan {
  id: string;
  chatId: number;
  userId: string;
  summary: string;
  operations: ChangeOperation[];
  createdAt: number;
  expiresAt: number;
}

export interface AgentReply {
  text: string;
  pendingChanges: PendingChangePlan[];
}

export type PendingLookup =
  | { ok: true; plan: PendingChangePlan }
  | { ok: false; reason: "not_found" | "expired" | "forbidden" };

export interface ChangeExecutionResult {
  ok: boolean;
  plan?: PendingChangePlan;
  completed: number;
  results: unknown[];
  error?: string;
  reason?: "not_found" | "expired" | "forbidden";
}

export interface TelegramAgentService {
  reply(chatId: number, userId: string, text: string): Promise<AgentReply>;
  reset(chatId: number): void;
  confirm(chatId: number, userId: string, id: string): Promise<ChangeExecutionResult>;
  cancel(chatId: number, userId: string, id: string): PendingLookup;
}

export interface CodexRunResult {
  threadId: string;
  finalResponse: string;
}

export interface CodexRunner {
  run(prompt: string, threadId?: string): Promise<CodexRunResult>;
  close?(): Promise<void> | void;
}

export class PendingChangeStore {
  readonly #plans = new Map<string, PendingChangePlan>();

  constructor(
    readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(
    chatId: number,
    userId: string,
    summary: string,
    operations: ChangeOperation[],
  ): PendingChangePlan {
    this.cleanup();
    const createdAt = this.now();
    const plan: PendingChangePlan = {
      id: randomBytes(6).toString("hex"),
      chatId,
      userId,
      summary,
      operations,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.#plans.set(plan.id, plan);
    return plan;
  }

  take(chatId: number, userId: string, id: string): PendingLookup {
    return this.#lookup(chatId, userId, id, true);
  }

  cancel(chatId: number, userId: string, id: string): PendingLookup {
    return this.#lookup(chatId, userId, id, true);
  }

  cleanup(): void {
    const now = this.now();
    for (const [id, plan] of this.#plans) {
      if (plan.expiresAt <= now) this.#plans.delete(id);
    }
  }

  #lookup(chatId: number, userId: string, id: string, consume: boolean): PendingLookup {
    const plan = this.#plans.get(id);
    if (!plan) return { ok: false, reason: "not_found" };
    if (plan.expiresAt <= this.now()) {
      this.#plans.delete(id);
      return { ok: false, reason: "expired" };
    }
    if (plan.chatId !== chatId || plan.userId !== userId) {
      return { ok: false, reason: "forbidden" };
    }
    if (consume) this.#plans.delete(id);
    return { ok: true, plan };
  }
}

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const attributePairsSchema = z.array(z.object({
  name: z.string().min(1).max(100),
  value: scalarSchema,
})).max(100);
const codexResponseSchema = z.object({
  message: z.string().min(1),
  changes: z.array(z.object({
    summary: z.string().min(3).max(500),
    operations: z.array(z.object({
      command: z.string().min(3).max(200),
      attributes: attributePairsSchema,
    })).min(1).max(20),
  })).max(5),
});

const scalarJsonSchema = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
  ],
};
const attributePairsJsonSchema = {
  type: "array",
  maxItems: 100,
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      value: scalarJsonSchema,
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
};
export const codexOutputJsonSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    changes: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          summary: { type: "string" },
          operations: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                command: { type: "string" },
                attributes: attributePairsJsonSchema,
              },
              required: ["command", "attributes"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "operations"],
        additionalProperties: false,
      },
    },
  },
  required: ["message", "changes"],
  additionalProperties: false,
};

export const telegramAgentInstructions = `Anda adalah operator MikroTik yang diakses melalui Telegram.
Gunakan MCP mikrotik untuk memeriksa setiap fakta tentang router. Jangan menebak status atau konfigurasi.
Jawab dengan bahasa pengguna, ringkas, jelas, dan cocok untuk layar ponsel.
Untuk permintaan baca, gunakan mikrotik_inspect atau mikrotik_query dan isi changes dengan array kosong.
Untuk permintaan perubahan, periksa kondisi router terlebih dahulu bila perlu, lalu masukkan rencana final ke changes. Jangan menjalankan perubahan sendiri.
Setiap operation harus memakai command RouterOS lengkap dan attributes berupa pasangan name/value.
Jika detail perubahan ambigu atau dapat memutus akses, tanyakan informasi yang kurang dan isi changes dengan array kosong.
Jangan meminta atau menampilkan password, private key, token, community string, atau secret.
Jangan mengubah file proyek. Fokus hanya pada permintaan administrasi MikroTik pengguna.`;

export class CodexCliRunner implements CodexRunner {
  readonly #binary: string;
  readonly #cwd: string;
  readonly #model: string | undefined;
  readonly #timeoutMs: number;
  #runtimeFiles: Promise<{ directory: string; schemaPath: string }> | undefined;

  constructor(options: {
    binary: string;
    cwd: string;
    model?: string;
    timeoutMs: number;
  }) {
    this.#binary = options.binary;
    this.#cwd = options.cwd;
    this.#model = options.model;
    this.#timeoutMs = options.timeoutMs;
  }

  async run(prompt: string, threadId?: string): Promise<CodexRunResult> {
    const runtime = await this.#getRuntimeFiles();
    const config = [
      'default_permissions="telegram-readonly"',
      'permissions.telegram-readonly.filesystem={":minimal"="read"}',
      'web_search="disabled"',
      `mcp_servers.mikrotik.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.mikrotik.args=${JSON.stringify([
        `--env-file=${join(this.#cwd, ".env")}`,
        join(this.#cwd, "dist/server.js"),
      ])}`,
      'mcp_servers.mikrotik.enabled_tools=["mikrotik_inspect","mikrotik_query"]',
    ].flatMap((value) => ["-c", value]);
    const args = threadId
      ? [
          "exec", "resume", "--json", "--ignore-user-config",
          "--output-schema", runtime.schemaPath,
          ...config,
          ...(this.#model ? ["--model", this.#model] : []),
          threadId, "-",
        ]
      : [
          "exec", "--json", "--color", "never", "--ignore-user-config",
          "--skip-git-repo-check", "--output-schema", runtime.schemaPath,
          ...config,
          "--cd", runtime.directory,
          ...(this.#model ? ["--model", this.#model] : []),
          "-",
        ];

    const childEnv = buildCodexEnvironment();

    return new Promise<CodexRunResult>((resolve, reject) => {
      const child = spawn(this.#binary, args, {
        cwd: this.#cwd,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let outputExceeded = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, this.#timeoutMs);
      timer.unref();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > 10_000_000) {
          outputExceeded = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-100_000);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Tidak dapat menjalankan Codex CLI: ${error.message}`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Codex melewati batas waktu ${Math.round(this.#timeoutMs / 1_000)} detik`));
          return;
        }
        if (outputExceeded) {
          reject(new Error("Output Codex terlalu besar"));
          return;
        }
        if (code !== 0) {
          reject(new Error(lastUsefulLine(stderr) || `Codex berhenti dengan exit code ${code}`));
          return;
        }
        try {
          resolve(parseCodexJsonLines(stdout, threadId));
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(`${telegramAgentInstructions}\n\nPesan pengguna:\n${prompt}`);
    });
  }

  async close(): Promise<void> {
    const runtime = this.#runtimeFiles ? await this.#runtimeFiles : undefined;
    if (runtime) rmSync(runtime.directory, { recursive: true, force: true });
    this.#runtimeFiles = undefined;
  }

  #getRuntimeFiles(): Promise<{ directory: string; schemaPath: string }> {
    if (!this.#runtimeFiles) {
      this.#runtimeFiles = (async () => {
        const directory = await mkdtemp(join(tmpdir(), "codex-mikrotik-telegram-"));
        const schemaPath = join(directory, "response.schema.json");
        await writeFile(schemaPath, JSON.stringify(codexOutputJsonSchema), { mode: 0o600 });
        process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
        return { directory, schemaPath };
      })();
    }
    return this.#runtimeFiles;
  }
}

export class CodexTelegramAgent implements TelegramAgentService {
  readonly #runner: CodexRunner;
  readonly #writeEnabled: boolean;
  readonly #threadIds = new Map<number, string>();
  readonly #pending: PendingChangeStore;

  constructor(options: {
    runner: CodexRunner;
    writeEnabled: boolean;
    pendingChangeTtlMs: number;
    pendingStore?: PendingChangeStore;
  }) {
    this.#runner = options.runner;
    this.#writeEnabled = options.writeEnabled;
    this.#pending = options.pendingStore ?? new PendingChangeStore(options.pendingChangeTtlMs);
  }

  reset(chatId: number): void {
    this.#threadIds.delete(chatId);
  }

  async reply(chatId: number, userId: string, text: string): Promise<AgentReply> {
    const result = await this.#runner.run(text, this.#threadIds.get(chatId));
    this.#threadIds.set(chatId, result.threadId);

    const parsed = codexResponseSchema.parse(JSON.parse(result.finalResponse) as unknown);
    const pendingChanges: PendingChangePlan[] = [];
    if (parsed.changes.length > 0 && !this.#writeEnabled) {
      return {
        text: `${parsed.message}\n\nOperasi tulis belum aktif. Set MIKROTIK_WRITE_ENABLED=true lalu restart bot untuk menampilkan konfirmasi perubahan.`,
        pendingChanges,
      };
    }

    for (const change of parsed.changes) {
      const operations = change.operations.map((operation) => ({
        command: operation.command,
        attributes: attributesFromPairs(operation.attributes),
      }));
      for (const operation of operations) {
        validateWriteOperation(operation.command, operation.attributes);
      }
      pendingChanges.push(this.#pending.create(chatId, userId, change.summary, operations));
    }

    return { text: parsed.message, pendingChanges };
  }

  async confirm(chatId: number, userId: string, id: string): Promise<ChangeExecutionResult> {
    const lookup = this.#pending.take(chatId, userId, id);
    if (!lookup.ok) return { ok: false, reason: lookup.reason, completed: 0, results: [] };

    const results: unknown[] = [];
    for (const operation of lookup.plan.operations) {
      try {
        results.push(await runWriteCommand(operation.command, operation.attributes));
      } catch (error) {
        return {
          ok: false,
          plan: lookup.plan,
          completed: results.length,
          results,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    this.reset(chatId);
    return { ok: true, plan: lookup.plan, completed: results.length, results };
  }

  cancel(chatId: number, userId: string, id: string): PendingLookup {
    return this.#pending.cancel(chatId, userId, id);
  }
}

function parseCodexJsonLines(stdout: string, existingThreadId?: string): CodexRunResult {
  let threadId = existingThreadId;
  let finalResponse: string | undefined;
  let reportedError: string | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      threadId = event.thread_id;
    }
    if (event.type === "item.completed" && isRecord(event.item)) {
      if (event.item.type === "agent_message" && typeof event.item.text === "string") {
        finalResponse = event.item.text;
      }
    }
    if (event.type === "error") {
      reportedError = typeof event.message === "string" ? event.message : JSON.stringify(event);
    }
    if (event.type === "turn.failed" && isRecord(event.error)) {
      reportedError = typeof event.error.message === "string"
        ? event.error.message
        : JSON.stringify(event.error);
    }
  }

  if (reportedError) throw new Error(reportedError);
  if (!threadId) throw new Error("Codex tidak mengirim thread ID");
  if (!finalResponse) throw new Error("Codex tidak mengirim jawaban akhir");
  return { threadId, finalResponse };
}

function attributesFromPairs(
  pairs: Array<{ name: string; value: RouterOsScalar }>,
): Record<string, RouterOsScalar> {
  const attributes: Record<string, RouterOsScalar> = {};
  for (const pair of pairs) {
    if (Object.hasOwn(attributes, pair.name)) {
      throw new Error(`Attribute duplikat: ${pair.name}`);
    }
    attributes[pair.name] = pair.value;
  }
  return attributes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function lastUsefulLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}

export function buildCodexEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = [
    "CODEX_HOME",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NODE_EXTRA_CA_CERTS",
    "PATH",
    "SHELL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TERM",
    "TMPDIR",
    "USER",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
