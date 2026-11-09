# ChatGPT Custom MCP integration

The project retains two independent integrations:
- Codex CLI: original stdio MCP entrypoint at dist/server.js, including its existing tool set.
- Telegram: Codex agent with shared network engineering guidance and bounded diagnostics.
- ChatGPT HTTP: optional stateless Streamable HTTP endpoint at dist/http-server.js.

## Recommended: Secure MCP Tunnel

Where ChatGPT offers a private Secure MCP Tunnel for local MCP processes, register
the existing command:

    node --env-file=/absolute/path/to/.env /absolute/path/to/dist/server.js

Follow the tunnel provider's current authenticated setup instructions. The command
above starts a stdio MCP process; it does not itself establish a tunnel. Keep
MIKROTIK_WRITE_ENABLED=false for this mode unless the tunnel environment itself
provides reliable human approval. The stronger local approval flow below applies
to the HTTP server, not the original stdio process.

## Streamable HTTP

1. Run npm ci and npm run build with Node 20 or newer.
2. Create a .env file (chmod 600), with RouterOS credentials and independent
   MCP_HTTP_BEARER_TOKEN obtained using openssl rand -hex 32.
3. Start using node --env-file=.env dist/http-server.js, or
   npm run pm2:http:start (PM2 assumes /root/codex-mikrotik).
4. Connect an authenticated HTTPS reverse proxy or private tunnel to
   127.0.0.1:8765, preserving HTTP POST, body and bearer header.
5. Configure your ChatGPT workspace's custom MCP connection with the HTTPS /mcp
   URL and the supported authentication mechanism.

The HTTP server binds only to loopback, rejects unknown browser Origin headers,
uses stateless JSON-RPC POST /mcp, and does not expose RouterOS API ports.
Do not publicly forward 8728, 8729, 8765, or 8766.
GET /health reports process health without disclosing router state.

**OAuth compatibility:** The HTTP endpoint validates a static Bearer token; it is
NOT an OAuth 2.1 authorization server. If your ChatGPT workspace requires OAuth,
use a correctly implemented OAuth gateway with protected-resource metadata,
authorization-server discovery, audience validation, and scopes. Do not claim
a static Bearer token is equivalent to OAuth. The Secure MCP Tunnel may be
preferable when available.

## HTTP tools and safe writes

The HTTP MCP offers:
- mikrotik_inspect: operational readings
- mikrotik_query: existing safe /print and /getall reads
- mikrotik_ethernet_monitor: actual negotiated Ethernet rate and duplex
- mikrotik_traffic: one RX/TX traffic snapshot per interface
- mikrotik_ping: bounded ICMP probes from the router
- mikrotik_guide: topic runbooks with official MikroTik references
- mikrotik_prepare_change: preview one exact RouterOS write
- mikrotik_commit_change: consume an approved one-time preview

It intentionally does NOT expose the original mikrotik_execute tool.

All transports use the guidance in [network-engineering.md](network-engineering.md).
MCP initialization includes diagnosis instructions; the same text is available
as the `mikrotik://knowledge/network-engineering` resource. Tool-only clients can
use `mikrotik_guide`. Reconnect or refresh the client after deploying a build to
discover new tools.

Keep HTTP writes disabled until a tested read-only deployment is running.
For changes, set these environment variables to secure values:

    MIKROTIK_WRITE_ENABLED=true
    MCP_HTTP_WRITE_ENABLED=true
    MCP_HTTP_WRITE_PREFIXES=/ip/firewall/address-list
    MCP_APPROVAL_TOKEN=<different random secret, at least 32 characters>
    MCP_APPROVAL_PORT=8766
    MCP_APPROVAL_TTL_SECONDS=300

Use a separate minimally privileged RouterOS API account, and TLS or VPN for
RouterOS API transport. Do not share one HTTP MCP token between administrators
with different privileges; it represents a single trust principal.

1. Request a change via ChatGPT to generate an exact command, attributes,
   preview ID, fingerprint and expiry time.
2. Inspect the complete preview before approving.
3. On the management server's interactive local terminal run:

    npm run mcp:approve -- <preview_id>

4. The CLI prints the RouterOS command and attributes, and requires entry of
   APPROVE followed by the exact full SHA-256 fingerprint.
5. Only after that, ask ChatGPT to commit the exact preview ID.

The separate approval API binds only to 127.0.0.1:8766 and requires its own
Bearer secret. Never put it behind the ChatGPT-facing proxy. Approval is
one-time, per operation, and expires automatically. Previews live in memory;
process restart invalidates them. There is no bulk-approval capability.

A preview is not a RouterOS dry run: a mistake can still disconnect the router.
Maintain backup and a separate management access path before risky writes.
Multiple writers could change state between preview and commit.

## Verification

Run:

    npm ci
    npm run typecheck
    npm test
    npm run build

The new HTTP tests cover token/origin validation, restricted paths, preview
approval, expiry, replay protection and an MCP initialize handshake. These tests
do not connect to a live MikroTik. Validate read-only operations against a test
router before enabling any writes.
