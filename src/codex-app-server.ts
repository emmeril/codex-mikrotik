import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  buildCodexEnvironment,
  codexOutputJsonSchema,
  telegramAgentInstructions,
  type CodexRunner,
  type CodexRunResult,
} from "./telegram-agent.js";

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveTurn {
  threadId: string;
  startedAt: number;
  finalResponse?: string;
  reportedError?: string;
  resolve: (result: CodexRunResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface EarlyTurnState {
  finalResponse?: string;
  reportedError?: string;
  completion?: Record<string, unknown>;
}

interface AppServerModel {
  id: string;
  model: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
}

export class CodexAppServerRunner implements CodexRunner {
  readonly #binary: string;
  readonly #cwd: string;
  readonly #requestedModel: string | undefined;
  readonly #reasoningEffort: string | undefined;
  readonly #serviceTier: string | undefined;
  readonly #timeoutMs: number;
  readonly #requests = new Map<number, PendingRequest>();
  readonly #turns = new Map<string, ActiveTurn>();
  readonly #earlyTurns = new Map<string, EarlyTurnState>();
  readonly #loadedThreads = new Set<string>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<void> | undefined;
  #runtimeDirectory: string | undefined;
  #selectedModel: string | undefined;
  #nextRequestId = 1;
  #stderr = "";
  #closing = false;

  constructor(options: {
    binary: string;
    cwd: string;
    model?: string;
    reasoningEffort?: string;
    serviceTier?: string;
    timeoutMs: number;
  }) {
    this.#binary = options.binary;
    this.#cwd = options.cwd;
    this.#requestedModel = options.model;
    this.#reasoningEffort = options.reasoningEffort;
    this.#serviceTier = options.serviceTier;
    this.#timeoutMs = options.timeoutMs;
  }

  async run(prompt: string, threadId?: string): Promise<CodexRunResult> {
    await this.#ensureStarted();
    let activeThreadId = threadId;
    if (!activeThreadId || !this.#loadedThreads.has(activeThreadId)) {
      activeThreadId = await this.#startThread();
    }
    const resolvedThreadId = activeThreadId;

    const response = asRecord(await this.#request("turn/start", {
      threadId: resolvedThreadId,
      input: [{ type: "text", text: prompt }],
      outputSchema: codexOutputJsonSchema,
      ...(this.#reasoningEffort ? { effort: this.#reasoningEffort } : {}),
      ...(this.#serviceTier ? { serviceTierForTurn: this.#serviceTier } : {}),
    }));
    const turn = asRecord(response.turn);
    const turnId = stringValue(turn.id, "Codex App Server tidak mengirim turn ID");

    return new Promise<CodexRunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#turns.delete(turnId);
        void this.#request("turn/interrupt", {
          threadId: resolvedThreadId,
          turnId,
        }, 5_000).catch(() => undefined);
        reject(new Error(`Codex melewati batas waktu ${Math.round(this.#timeoutMs / 1_000)} detik`));
      }, this.#timeoutMs);
      timer.unref();
      this.#turns.set(turnId, {
        threadId: resolvedThreadId,
        startedAt: Date.now(),
        resolve,
        reject,
        timer,
      });
      this.#applyEarlyTurnState(turnId);
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    const child = this.#process;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolve();
        }, 2_000);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.#runtimeDirectory) {
      rmSync(this.#runtimeDirectory, { recursive: true, force: true });
      this.#runtimeDirectory = undefined;
    }
  }

  async #ensureStarted(): Promise<void> {
    if (this.#process && this.#process.exitCode === null) return;
    if (!this.#starting) {
      this.#starting = this.#start().catch(async (error) => {
        await this.close();
        this.#starting = undefined;
        throw error;
      });
    }
    await this.#starting;
  }

  async #start(): Promise<void> {
    this.#closing = false;
    this.#stderr = "";
    this.#runtimeDirectory = await mkdtemp(join(tmpdir(), "codex-mikrotik-app-server-"));
    const config = [
      'approval_policy="never"',
      'default_permissions="telegram-readonly"',
      'permissions.telegram-readonly.filesystem={":minimal"="read"}',
      'web_search="disabled"',
      'analytics.enabled=false',
      `mcp_servers.mikrotik.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.mikrotik.args=${JSON.stringify([
        `--env-file=${join(this.#cwd, ".env")}`,
        join(this.#cwd, "dist/server.js"),
      ])}`,
      'mcp_servers.mikrotik.required=true',
      'mcp_servers.mikrotik.enabled_tools=["mikrotik_inspect","mikrotik_query"]',
      'mcp_servers.mikrotik.disabled_tools=["mikrotik_execute"]',
    ].flatMap((value) => ["-c", value]);
    const child = spawn(this.#binary, ["app-server", "--stdio", ...config], {
      cwd: this.#runtimeDirectory,
      env: buildCodexEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.#process = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-100_000);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    child.once("error", (error) => this.#handleExit(new Error(`Codex App Server gagal dijalankan: ${error.message}`)));
    child.once("exit", (code, signal) => {
      const detail = usefulLine(this.#stderr);
      this.#handleExit(new Error(
        detail || `Codex App Server berhenti (${signal ?? `exit ${code ?? "unknown"}`})`,
      ));
    });

    await this.#request("initialize", {
      clientInfo: {
        name: "codex_mikrotik_telegram",
        title: "Codex MikroTik Telegram",
        version: "0.1.0",
      },
      capabilities: {
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
        ],
      },
    }, 15_000);
    this.#notify("initialized", {});

    const models = asRecord(await this.#request("model/list", {
      limit: 100,
      includeHidden: false,
    }, 15_000));
    const available = Array.isArray(models.data)
      ? models.data.filter(isAppServerModel)
      : [];
    const selected = this.#requestedModel
      ? available.find((model) => model.model === this.#requestedModel || model.id === this.#requestedModel)
      : available.find((model) => model.isDefault) ?? available[0];
    if (!selected) {
      throw new Error(this.#requestedModel
        ? `Model Codex tidak tersedia: ${this.#requestedModel}`
        : "Codex App Server tidak mengirim model yang tersedia");
    }
    this.#selectedModel = selected.model;
    console.error(`Codex App Server ready model=${selected.model}`);
  }

  async #startThread(): Promise<string> {
    if (!this.#runtimeDirectory || !this.#selectedModel) {
      throw new Error("Codex App Server belum siap");
    }
    const response = asRecord(await this.#request("thread/start", {
      model: this.#selectedModel,
      cwd: this.#runtimeDirectory,
      approvalPolicy: "never",
      serviceName: "codex_mikrotik_telegram",
      developerInstructions: telegramAgentInstructions,
      ephemeral: true,
      ...(this.#serviceTier ? { serviceTier: this.#serviceTier } : {}),
    }));
    const thread = asRecord(response.thread);
    const id = stringValue(thread.id, "Codex App Server tidak mengirim thread ID");
    this.#loadedThreads.add(id);
    return id;
  }

  #request(method: string, params: unknown, timeoutMs = this.#timeoutMs): Promise<unknown> {
    const child = this.#process;
    if (!child || child.exitCode !== null || child.stdin.destroyed) {
      return Promise.reject(new Error("Codex App Server tidak aktif"));
    }
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(id);
        reject(new Error(`Codex App Server timeout pada ${method}`));
      }, timeoutMs);
      timer.unref();
      this.#requests.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.#requests.delete(id);
        reject(error);
      });
    });
  }

  #notify(method: string, params: unknown): void {
    const child = this.#process;
    if (!child || child.exitCode !== null || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  #handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = asRecord(JSON.parse(line) as unknown);
    } catch {
      console.error("Codex App Server mengirim JSON yang tidak valid");
      return;
    }

    if ((typeof message.id === "number" || typeof message.id === "string") && !message.method) {
      this.#handleResponse(message as unknown as JsonRpcResponse);
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      this.#handleServerRequest(message);
      return;
    }
    if (typeof message.method === "string") this.#handleNotification(message.method, message.params);
  }

  #handleResponse(message: JsonRpcResponse): void {
    if (typeof message.id !== "number") return;
    const pending = this.#requests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#requests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `Codex App Server error ${message.error.code ?? "unknown"}`));
    } else {
      pending.resolve(message.result);
    }
  }

  #handleServerRequest(message: Record<string, unknown>): void {
    const child = this.#process;
    if (!child || child.stdin.destroyed) return;
    const method = String(message.method);
    const id = message.id;
    const response = method === "item/commandExecution/requestApproval"
      || method === "item/fileChange/requestApproval"
      ? { id, result: { decision: "decline" } }
      : { id, error: { code: -32601, message: `Unsupported server request: ${method}` } };
    child.stdin.write(`${JSON.stringify(response)}\n`);
  }

  #handleNotification(method: string, rawParams: unknown): void {
    const params = asRecord(rawParams);
    const turnId = typeof params.turnId === "string"
      ? params.turnId
      : isRecord(params.turn) && typeof params.turn.id === "string"
        ? params.turn.id
        : undefined;
    if (!turnId) return;

    if (method === "item/completed") {
      const item = asRecord(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        const active = this.#turns.get(turnId);
        if (active) active.finalResponse = item.text;
        else this.#earlyState(turnId).finalResponse = item.text;
      }
      return;
    }
    if (method === "error") {
      const error = asRecord(params.error);
      const detail = typeof error.message === "string" ? error.message : "Codex turn gagal";
      const active = this.#turns.get(turnId);
      if (active) active.reportedError = detail;
      else this.#earlyState(turnId).reportedError = detail;
      return;
    }
    if (method === "turn/completed") {
      const completion = asRecord(params.turn);
      if (this.#turns.has(turnId)) this.#finishTurn(turnId, completion);
      else this.#earlyState(turnId).completion = completion;
    }
  }

  #earlyState(turnId: string): EarlyTurnState {
    const existing = this.#earlyTurns.get(turnId);
    if (existing) return existing;
    const state: EarlyTurnState = {};
    this.#earlyTurns.set(turnId, state);
    return state;
  }

  #applyEarlyTurnState(turnId: string): void {
    const early = this.#earlyTurns.get(turnId);
    if (!early) return;
    this.#earlyTurns.delete(turnId);
    const active = this.#turns.get(turnId);
    if (!active) return;
    if (early.finalResponse !== undefined) active.finalResponse = early.finalResponse;
    if (early.reportedError !== undefined) active.reportedError = early.reportedError;
    if (early.completion) this.#finishTurn(turnId, early.completion);
  }

  #finishTurn(turnId: string, completion: Record<string, unknown>): void {
    const active = this.#turns.get(turnId);
    if (!active) return;
    clearTimeout(active.timer);
    this.#turns.delete(turnId);
    const durationMs = Date.now() - active.startedAt;
    const status = typeof completion.status === "string" ? completion.status : "unknown";
    console.error(`Codex turn status=${status} duration_ms=${durationMs}`);
    if (status !== "completed") {
      const error = isRecord(completion.error) && typeof completion.error.message === "string"
        ? completion.error.message
        : active.reportedError || `Codex turn berakhir dengan status ${status}`;
      active.reject(new Error(error));
      return;
    }
    if (!active.finalResponse) {
      active.reject(new Error("Codex App Server tidak mengirim jawaban akhir"));
      return;
    }
    active.resolve({ threadId: active.threadId, finalResponse: active.finalResponse });
  }

  #handleExit(error: Error): void {
    if (!this.#process) return;
    this.#process = undefined;
    this.#starting = undefined;
    this.#selectedModel = undefined;
    this.#loadedThreads.clear();
    for (const pending of this.#requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#requests.clear();
    for (const active of this.#turns.values()) {
      clearTimeout(active.timer);
      active.reject(error);
    }
    this.#turns.clear();
    this.#earlyTurns.clear();
    if (this.#runtimeDirectory) {
      rmSync(this.#runtimeDirectory, { recursive: true, force: true });
      this.#runtimeDirectory = undefined;
    }
    if (!this.#closing) console.error(error.message);
  }
}

function isAppServerModel(value: unknown): value is AppServerModel {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.model === "string"
    && typeof value.hidden === "boolean"
    && typeof value.isDefault === "boolean";
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

function usefulLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
}
