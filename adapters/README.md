# adapters/

How a new agent joins the OS — one folder per adapter as they are built.

Every agent supports all 11 connection methods with automatic fallback:
REST API + key · MCP · CLI bridge · webhook · WebSocket · log watcher ·
file/folder bridge · SSH · browser session · n8n bridge · manual copy-paste.

Existing bridges live in `core/bridge/`:

- `hermes-bridge.mjs` — reads Hermes' state files on the VPS (data only) and
  posts heartbeat + state-change events to the Core every 2 minutes.
- `n8n-hub-bridge.py` — syncs the n8n Agent Hub queue (dot/codex) into the
  Core every 10 minutes.

The event protocol and Hub operations are specified in
`docs/AGENT-ONBOARDING.md`; the generic adapter contract is in
`docs/MASTER-PLAN.md` §4.
