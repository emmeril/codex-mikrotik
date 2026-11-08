#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMikrotikMcpServer } from "./mcp-server.js";

async function main(): Promise<void> {
  const server = createMikrotikMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("codex-mikrotik MCP server ready");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
