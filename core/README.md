# Agentic OS Core (P2)

The real backend for Jafrul's Agentic OS: an append-only **event store**, a
**REST API**, and a **WebSocket live stream** that the dashboard (and later,
every agent adapter) talks to. This replaces the P1 labelled simulation —
events posted here are real rows in a real database.

- **Runtime:** Node 24, plain ESM JavaScript, no build step.
- **WebSocket:** the `ws` package.
- **Database:** Node's built-in `node:sqlite` at `data/agentic-os.db`
  (gitignored). The schema mirrors the PostgreSQL design in
  `../docs/MASTER-PLAN.md` — same table/column names — so the P5 VPS deploy
  can migrate to Postgres by replaying the DDL with type swaps.
- **Port:** `4310` (override with env `PORT`).

## Run

```bash
cd core
npm install
npm start          # http://localhost:4310  ·  ws://localhost:4310/ws
```

On first boot the DB is created and seeded (idempotently — only empty
tables are seeded) with the same inventory as the frontend: 4 agents,
3 projects, 13 phases, 13 tasks, 5 handovers, 44 connections
(11 methods × 4 agents) and the top-30 Second Brain hubs from
`../brain/stats.json`.

## ⚠️ API key — dev default warning

Adapter ingest (`POST /api/events`) requires the header `x-api-key`.
The value comes from env `AGENTIC_API_KEY` and **defaults to `dev-key`,
which is for local development only**. Set a real key before exposing the
core anywhere:

```bash
AGENTIC_API_KEY='<a long random secret>' npm start
```

## REST endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok: true }` |
| GET | `/api/state` | — | Full snapshot: agents, projects, phases, tasks, handovers, connections, knowledge nodes, brain stats, recent events |
| POST | `/api/events` | `x-api-key` | Generic Adapter Protocol ingest (below) |
| POST | `/api/handovers` | — | Create a handover `{ title, toAgent, fromAgent?, note? }` (starts `pending`) |
| POST | `/api/handovers/:id/advance` | — | Step `pending → sent → accepted → running → completed`. On **accepted**, the linked task's ownership moves to the target agent (a task is created and linked if none exists yet) |
| POST | `/api/chat/:agentId` | — | `{ message }` — stores the message and a reply. For `Muse` the reply is generated from **real state** (running tasks, progress, blockers, project roll-up, brain stats — rule-based, no LLM). For other agents the stored reply honestly says the message is queued until that agent's P3 adapter goes live |

## WebSocket (`/ws`)

- On connect the server sends `{ "type": "snapshot", "state": { ... } }`.
- Every mutation broadcasts `{ "type": "event", "event": { ... } }` and,
  when state rows changed, `{ "type": "state.patch", "patch": { tasks: [...], ... } }`.
- Send `{ "type": "ping" }` → receive `{ "type": "pong" }`.

## Generic Adapter Protocol

Any agent joins the OS by posting 6 event types (MASTER-PLAN §4):

`heartbeat` · `task.started` · `task.progress` · `task.done` · `task.blocked` · `chat.message`

Effects: events are appended to the store; `task.started` creates/updates a
task owned by the posting agent (status `running`); `task.progress` updates
its progress; `task.done` / `task.blocked` close/flag it; `heartbeat`
refreshes the agent's `last_seen`.

```bash
curl -X POST http://localhost:4310/api/events \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev-key' \
  -d '{"agentId":"claude","type":"task.progress","taskTitle":"P2 Core build","progress":40}'
```

### Emit CLI (the easy way)

```bash
node bin/emit.mjs claude heartbeat '{}'
node bin/emit.mjs claude task.started  '{"taskTitle":"P2 Core build","projectId":"agentic-os"}'
node bin/emit.mjs claude task.progress '{"taskTitle":"P2 Core build","progress":40}'
node bin/emit.mjs hermes task.done     '{"taskTitle":"Agent Hub health check"}'
```

Env for the CLI: `AGENTIC_CORE_URL` (default `http://localhost:4310`),
`AGENTIC_API_KEY` (default `dev-key`).

## Layout

```
core/
  src/db.mjs       schema + idempotent seed + brain summary
  src/server.mjs   HTTP REST + WebSocket server, adapter ingest, handovers, chat
  bin/emit.mjs     CLI for agents to post events
  data/            agentic-os.db (created at runtime, gitignored)
```

## Postgres migration note (P5)

Tables/columns intentionally match the master plan's Postgres design
(`agents, projects, phases, tasks, handovers, events, connections,
knowledge_nodes, chat_messages`). To migrate: create the same tables in
Postgres (`AUTOINCREMENT` → `SERIAL`, JSON payloads → `JSONB`), copy rows,
and swap the `node:sqlite` calls in `src/db.mjs`/`src/server.mjs` for a
`pg` client — the query shapes stay the same.
