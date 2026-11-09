import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMikrotikMcpServer } from "../src/mcp-server.js";
import { READ_ONLY_TOOL_NAMES } from "../src/network-engineer.js";

test("MCP clients discover diagnosis tools, instructions and offline runbooks without router credentials", async (context) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMikrotikMcpServer();
  const client = new Client({ name: "network-test", version: "1" });
  context.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.match(client.getInstructions() ?? "", /negotiated_rate/);
  const { tools } = await client.listTools();
  for (const name of READ_ONLY_TOOL_NAMES) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    assert.equal(tool.annotations?.readOnlyHint, true);
  }
  const runbook = await client.callTool({ name: "mikrotik_guide", arguments: { topic: "routing" } });
  assert.ok(!runbook.isError);
  const content = runbook.content as Array<{ type: string; text: string }>;
  const guide = JSON.parse(content[0]!.text);
  assert.equal(guide.topic, "routing");
  assert.ok(guide.checks.length > 0);
  assert.ok(guide.sources.every((url: string) => url.startsWith("https://help.mikrotik.com/")));
  const resource = await client.readResource({ uri: "mikrotik://knowledge/network-engineering" });
  assert.match(String(resource.contents[0]?.text), /bukan internet sehat/);
  const invalid = await client.callTool({ name: "mikrotik_ping", arguments: { address: "192.0.2.1", count: 100 } });
  assert.equal(invalid.isError, true);
});
