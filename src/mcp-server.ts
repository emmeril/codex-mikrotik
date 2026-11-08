import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import {
  INSPECTION_TARGETS,
  inspectRouter,
  runReadCommand,
  runWriteCommand,
} from "./tools.js";
import {
  HttpApprovalStore,
  type HttpConfig,
  validateHttpWrite,
  principalForToken,
} from "./http-security.js";

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const attributesSchema = z
  .record(z.string(), scalar)
  .default({})
  .describe("RouterOS API attributes without the leading '='");

export function createMikrotikMcpServer(
  http?: { config: HttpConfig; approvals: HttpApprovalStore },
): McpServer {
  const server = new McpServer({
    name: "codex-mikrotik",
    version: "0.2.0",
  });

  server.registerTool(
    "mikrotik_inspect",
    {
      title: "Inspect MikroTik",
      description:
        "Read operational data from a MikroTik RouterOS 6 or 7 router. Use target=router to verify connectivity and version.",
      inputSchema: {
        target: z
          .enum(["router", ...Object.keys(INSPECTION_TARGETS)] as [
            "router", ...(keyof typeof INSPECTION_TARGETS)[],
          ])
          .describe("Data set to inspect"),
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: {
        readOnlyHint: true, destructiveHint: false,
        idempotentHint: true, openWorldHint: true,
      },
    },
    async ({ target, limit }) => toolResult(() => inspectRouter(target, limit)),
  );

  server.registerTool(
    "mikrotik_query",
    {
      title: "Query RouterOS",
      description:
        "Run a read-only RouterOS API /print or /getall command. Query words use RouterOS syntax, such as ?disabled=false.",
      inputSchema: {
        command: z.string().min(3).max(200).describe("Example: /ip/firewall/nat/print"),
        attributes: attributesSchema.optional(),
        queries: z.array(z.string()).max(20).default([]),
        proplist: z.array(z.string()).max(100).default([]),
        limit: z.number().int().min(1).max(1000).default(100),
      },
      annotations: {
        readOnlyHint: true, destructiveHint: false,
        idempotentHint: true, openWorldHint: true,
      },
    },
    async ({ command, attributes, queries, proplist, limit }) =>
      toolResult(() =>
        runReadCommand(command, {
          ...(attributes ? { attributes } : {}),
          queries, proplist, limit,
        }),
      ),
  );

  if (http) {
    const { config, approvals } = http;

    server.registerTool(
      "mikrotik_prepare_change",
      {
        title: "Preview RouterOS configuration change",
        description:
          "Prepare but do NOT execute a single allowlisted RouterOS write. Requires separate terminal administrator approval. Return the exact preview id, fingerprint and expiration to the user.",
        inputSchema: {
          command: z.string().min(3).max(200),
          attributes: attributesSchema,
        },
        annotations: {
          readOnlyHint: true, destructiveHint: false,
          idempotentHint: false, openWorldHint: false,
        },
      },
      async ({ command, attributes }) => toolResult(() => {
        validateHttpWrite(command, attributes, config);
        return {
          status: "awaiting_local_administrator",
          ...approvals.create(principalForToken(config.bearerToken), command, attributes),
        };
      }),
    );

    server.registerTool(
      "mikrotik_commit_change",
      {
        title: "Apply administrator-approved RouterOS change",
        description:
          "Use only after the human administrator approves the exact preview locally. A one-time approval is required and the proposed command cannot be modified.",
        inputSchema: {
          preview_id: z.string().uuid(),
        },
        annotations: {
          readOnlyHint: false, destructiveHint: true,
          idempotentHint: false, openWorldHint: false,
        },
      },
      async ({ preview_id }) => toolResult(async () => {
        const taken = approvals.take(preview_id, principalForToken(config.bearerToken));
        if (!taken.ok) throw new Error("Approval required: " + taken.reason);
        const { command, attributes } = taken.change;
        validateHttpWrite(command, attributes, config);
        return await runWriteCommand(command, attributes);
      }),
    );
  } else {
    server.registerTool(
      "mikrotik_execute",
      {
        title: "Change RouterOS configuration",
        description:
          "Run an allowlisted RouterOS write command. Disabled unless MIKROTIK_WRITE_ENABLED=true. The caller must explicitly confirm each operation.",
        inputSchema: {
          command: z.string().min(3).max(200),
          attributes: attributesSchema,
          confirm: z.literal(true).describe("Must be true after reviewing the exact command"),
        },
        annotations: {
          readOnlyHint: false, destructiveHint: true,
          idempotentHint: false, openWorldHint: true,
        },
      },
      async ({ command, attributes }) => toolResult(() => runWriteCommand(command, attributes)),
    );
  }

  return server;
}

async function toolResult(operation: () => Promise<unknown> | unknown) {
  try {
    const result = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: message }],
    };
  }
}
