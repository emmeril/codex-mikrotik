#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadHttpConfig } from "./http-security.js";

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
    throw new Error("Usage: npm run mcp:approve -- <preview_id>");
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Approval requires an interactive administrator terminal");
  }
  const config = loadHttpConfig();
  if (!config.writeEnabled || !config.approvalToken) {
    throw new Error("HTTP MCP write approval is not enabled");
  }
  const url = "http://127.0.0.1:" + config.adminPort;
  const headers = {
    Authorization: "Bearer " + config.approvalToken,
    "Content-Type": "application/json",
  };
  const previewResponse = await fetch(url + "/pending/" + id, { headers });
  if (!previewResponse.ok) throw new Error("Preview not found or expired");
  const preview = await previewResponse.json() as {
    id: string; command: string; attributes: Record<string, unknown>;
    fingerprint: string; expiresAt: number;
  };
  stdout.write(
    "\nRouterOS command: " + preview.command +
    "\nAttributes: " + JSON.stringify(preview.attributes, null, 2) +
    "\nFingerprint: " + preview.fingerprint +
    "\nExpires: " + new Date(preview.expiresAt).toISOString() + "\n",
  );
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(
      "\nType APPROVE " + preview.fingerprint + " to authorize this exact operation: ",
    );
    if (answer !== "APPROVE " + preview.fingerprint) {
      stdout.write("Not approved.\n");
      return;
    }
  } finally {
    readline.close();
  }
  const result = await fetch(url + "/approve", {
    method: "POST", headers,
    body: JSON.stringify({ id: preview.id, fingerprint: preview.fingerprint }),
  });
  if (!result.ok) throw new Error("Approval failed, expired, or already used");
  stdout.write("Approved once. The ChatGPT tool must still request execution before expiry.\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
