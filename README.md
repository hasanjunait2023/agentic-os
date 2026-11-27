# Agentic OS

A realtime command center for a team of AI agents working for one owner —
**Jafrul** (founder; business in Bangladesh, Asia/Dhaka UTC+6).

One screen answers: *which agent is doing what, on which project, how far
along, what is blocked, and who should take over next* — with live updates,
structured handovers, and one shared Second Brain.

## Live deployment

| Piece | Where |
|---|---|
| Frontend (this repo's `web/`) | Vercel — https://agentic-os-ecomexs-projects.vercel.app |
| Core API + DB | VPS — https://os.ecomex.cloud (`/api/health`, `/api/state`) |
| Agent Hub (job queue) | n8n — "Agent Hub - Job Queue" + "Agent Hub - MCP" workflows |
| Second Brain | Obsidian vault `hasanjunait2023/second-brain` (private, separate repo) |

## The agents

| Agent | Role | How it connects |
|---|---|---|
| **Muse** | Orchestrator — plans, coordinates, verifies | Native session |
| **Claude Code** | Deep coding in repos | CLI bridge |
| **Hermes Agent** | Automation, monitoring, Telegram, cron | State-file bridge (VPS, every 2 min) + Agent Hub |
| **Dot** (OpenAI) | Research, web | n8n Agent Hub |
| **Codex** (OpenAI) | Coding, automation | n8n Agent Hub |

Every agent keeps **all 11 connection methods** available — REST API + key,
MCP, CLI bridge, webhook, WebSocket, log watcher, file/folder bridge, SSH,
browser session, n8n bridge, manual copy-paste — with automatic fallback.
No agent is ever blocked because one method is missing.

## Repository layout

```
web/            Single-file frontend (10 pages: Dashboard, Agents, Team, Chat,
                Projects, Plans, Activity, Handovers, Connect, Brain)
core/           The Core: Node ESM + ws WebSocket + SQLite (schema mirrors
                PostgreSQL for later migration)
  src/          db.mjs (schema + seed), server.mjs (REST + WS)
  bin/emit.mjs  Adapter emit CLI — how any agent reports events
  bridge/       hermes-bridge.mjs (Hermes state → Core),
                n8n-hub-bridge.py (Agent Hub ⇄ Core sync for dot/codex)
docs/           MASTER-PLAN.md, SHARED-BRAIN-PROTOCOL.md, AGENT-ONBOARDING.md
tools/          Second Brain sync + graph builder
hermes-pack/    Rules + skills installed into Hermes Agent (SOUL.md section,
                skills/agentic-os, skills/shared-brain)
adapters/       Adapter protocol notes for new agents
brain/          Generated brain stats land here (not committed; see README)
```

## Run the Core locally

```bash
cd core
npm install
AGENTIC_API_KEY=dev-key node --experimental-sqlite src/server.mjs   # port 4310
curl localhost:4310/api/health
```

Report an event like any adapter does:

```bash
AGENTIC_API_KEY=dev-key node bin/emit.mjs hermes task.progress "Indexing the queue" 40
```

## Working in this repo as an agent

Read **`docs/AGENT-ONBOARDING.md`** first — it has the event protocol, the
handover flow, the Agent Hub operations, and the house rules. Then
`docs/MASTER-PLAN.md` for the full design and `docs/SHARED-BRAIN-PROTOCOL.md`
for how to read/write the shared Second Brain.

## Secrets

No secrets live in this repo. The Core reads its API key from the environment
(`AGENTIC_API_KEY`); the frontend build expects the key to be injected where
`YOUR_AGENTIC_API_KEY` appears in `web/index.html`. Production values live
only on the VPS (`/opt/agentic-os/.env`, chmod 600).
