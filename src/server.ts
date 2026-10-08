#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  INSPECTION_TARGETS,
  inspectRouter,
  runReadCommand,
  runWriteCommand,
} from "./tools.js";

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const attributesSchema = z
  .record(z.string(), scalar)
  .default({})
  .describe("RouterOS API attributes without the leading '='");

const server = new McpServer({
  name: "codex-mikrotik",
  version: "0.1.0",
});

server.registerTool(
  "mikrotik_inspect",
  {
    title: "Inspect MikroTik",
    description:
      "Read common operational data from a MikroTik RouterOS 6 or 7 router. Use target=router first to verify connectivity and version.",
    inputSchema: {
      target: z
        .enum(["router", ...Object.keys(INSPECTION_TARGETS)] as [
          "router",
          ...(keyof typeof INSPECTION_TARGETS)[],
        ])
        .describe("Data set to inspect"),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ target, limit }) => toolResult(() => inspectRouter(target, limit)),
);

server.registerTool(
  "mikrotik_query",
  {
    title: "Query RouterOS",
    description:
      "Run an arbitrary read-only RouterOS API /print or /getall command. Query words must use RouterOS syntax such as ?disabled=false.",
    inputSchema: {
      command: z.string().min(3).max(200).describe("Example: /ip/firewall/nat/print"),
      attributes: attributesSchema.optional(),
      queries: z.array(z.string()).max(20).default([]),
      proplist: z.array(z.string()).max(100).default([]),
      limit: z.number().int().min(1).max(1000).default(100),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ command, attributes, queries, proplist, limit }) =>
    toolResult(() =>
      runReadCommand(command, {
        ...(attributes ? { attributes } : {}),
        queries,
        proplist,
        limit,
      }),
    ),
);

server.registerTool(
  "mikrotik_execute",
  {
    title: "Change RouterOS configuration",
    description:
      "Run an allowlisted RouterOS write command. Disabled unless MIKROTIK_WRITE_ENABLED=true. The caller must explicitly confirm each operation.",
    inputSchema: {
      command: z
        .string()
        .min(3)
        .max(200)
        .describe("Example: /ip/address/add or /ip/firewall/filter/set"),
      attributes: attributesSchema,
      confirm: z.literal(true).describe("Must be true after reviewing the exact command"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ command, attributes }) =>
    toolResult(() => runWriteCommand(command, attributes)),
);

async function toolResult(operation: () => Promise<unknown>) {
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

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error("codex-mikrotik MCP server ready");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
