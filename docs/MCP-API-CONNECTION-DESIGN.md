# MCP + API Connection Design — Agentic OS

**Date:** 2026-11-27 · **Status:** Design + Phase 1 code written, NOT wired in, NOT run
**Ask from Jafrul:** "MCP দিয়ে কানেকশন করবার জন্য অথবা API যেন আমি create করতে পারি" — he wants to
create connections himself, from the OS, the way the custom-connector API-key link worked.
**Current repo:** HEAD `3471d9c` · Core `0.2.0` · Node ESM + `ws` only · SQLite (`node:sqlite`)

## 1. What exists today (verified, not assumed)

| Piece | Where | Reality |
|---|---|---|
| Connect page | `web/index.html` L508–525, L604–608, L1054–1065 | Static 11×4 matrix. `CONNECT_METHODS` + `CONNECT_STATUS` are hardcoded JS; `renderConnectLive()` only repaints statuses from `/api/state.connections`. MCP column says "Connected" for Muse / "Ready" for others — **display only, no MCP server exists**. |
| Frontend key | `web/index.html` L882 | `key: 'YOUR_AGENTIC_API_KEY'` — a placeholder to inject at build. No UI anywhere to create a key. |
| Auth | `core/src/server.mjs` | ONE master key: env `AGENTIC_API_KEY` (default `dev-key`). `POST /api/events`, `/api/handovers`, `/api/chat/:agentId` all check `x-api-key !== API_KEY`. No per-key keys, no create/list/revoke. |
| DB | `core/src/db.mjs` | Tables: agents, projects, phases, tasks, handovers, events, connections, knowledge_nodes, chat_messages. **No `api_keys` table.** `connections` is seed display data. |
| CLI adapter | `core/bin/emit.mjs` | `POST /api/events` with `x-api-key` — the pattern MCP tools follow. |
| Plan | `docs/MASTER-PLAN.md` §4–§4.1 | All 11 methods must exist with a fallback ladder; MCP is method #2; Claude Code via MCP server is P3; Generic Adapter Protocol = 4 events via REST POST + API key (P2). |

**Gap, in one line:** the OS *shows* MCP and API-key connections, but it cannot *make* either — no
MCP endpoint exists, and the only API key lives in the VPS `.env`, creatable by no one from the UI.

## 2. The design — two features, one auth model

```
MCP client (Claude Code / Desktop / any agent) ─┐
                                                 ├─► MCP server (core/src/mcp-server.mjs)
Jafrul on Connect page ── Create API key ────────┤      ├─ stdio  (local, no key — same machine)
  (key shown ONCE, copy it)                      │      └─ POST /mcp (Streamable HTTP, x-api-key)
External service ── x-api-key: agk_live_… ───────┘
                                                 ├─► api_keys table (SHA-256 only, scoped)
Core REST (existing) ── POST /api/events etc. ────┘      master key keeps working as today
```

**One auth model for everything:** every credential is either the master key (env, all scopes)
or a per-key key (`agk_live_…`, scoped). MCP over HTTP and REST use the same checker
(`authenticateApiKey()` in `core/src/api-keys.mjs`). Scopes:
`state:read`, `events:write`, `handovers:write`, `chat:write`, `keys:manage`.

## 3. Feature A — MCP server (`core/src/mcp-server.mjs`, NEW, zero-dependency)

No new npm dependency on purpose: `core/package.json` stays minimal (`ws` only) and the MCP
protocol is plain JSON-RPC 2.0, implemented by hand. If the team later adopts
`@modelcontextprotocol/sdk`, the `TOOLS` table in this file is the spec to port — tool names
and shapes do not change.

**Transports**
- **stdio** — `node src/mcp-server.mjs --stdio`. Local agents (Claude Code). No key: same-machine
  trust, exactly like the CLI bridge. Register: `claude mcp add agentic-os -- node /path/to/core/src/mcp-server.mjs --stdio`
- **Streamable HTTP** — `POST /mcp` on the Core. Remote clients (Claude Desktop remote, other
  agents). Header `x-api-key: <master or agk_live_…>`. Single JSON response per request (no SSE
  stream yet); `GET /mcp` → 405. Mounted by `server.mjs` via exported `handleMcpHttp()` (wiring §6).

**Handshake:** `initialize` negotiates `2025-03-26` (also accepts `2024-11-05`), returns
`capabilities: { tools: {}, resources: {} }` and `serverInfo: { name: 'agentic-os-core', version: '0.2.0' }`.
`ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list` (empty),
`resources/templates/list` (empty). Unknown method → `-32601`; bad params → `-32603` via handler errors.

**Tools** (each enforces its scope; stdio runs with all scopes as `local`):

| Tool | Scope | What it does (Core semantics) |
|---|---|---|
| `agentic_get_state` | `state:read` | Whole board — same payload as `GET /api/state` |
| `agentic_list_agents` | `state:read` | Agents + status, current task, `last_seen` |
| `agentic_list_tasks` | `state:read` | Tasks, filter `status` / `owner` / `projectId` |
| `agentic_emit_event` | `events:write` | Generic Adapter Protocol: `heartbeat`, `task.started`, `task.progress`, `task.done`, `task.blocked`, `chat.message`. Same task upsert + agent pointer logic as `server.mjs` |
| `agentic_create_handover` | `handovers:write` | Handover ticket (`pending`) |
| `agentic_advance_handover` | `handovers:write` | `pending → sent → accepted → running → completed`; ownership moves on accept |
| `agentic_chat` | `chat:write` | Talk to an agent; Muse answers from live state, others queue |

**Resources:** `agentic://state`, `agentic://agents`, `agentic://activity` (recent events).

**Side effect that makes the Connect page go live:** every MCP event also runs
`UPDATE connections SET status='Connected' WHERE agent_id=? AND method='MCP'` — so the matrix
stops being seed data and reflects real connections.

**Client configs (copy-paste, Connect page §5):**
```json
// Claude Code (local, stdio) — terminal:
//   claude mcp add agentic-os -- node /opt/agentic-os/core/src/mcp-server.mjs --stdio
// Claude Desktop / remote client (HTTP) — claude_desktop_config.json:
{ "mcpServers": { "agentic-os": {
  "url": "https://os.ecomex.cloud/mcp",
  "headers": { "x-api-key": "agk_live_… (paste the key you created below)" }
} } }
```

## 4. Feature B — Create API keys (`core/src/api-keys.mjs`, NEW)

- **Table `api_keys`:** `id, name, key_prefix, key_hash (UNIQUE), scopes (JSON), agent_id?, created_at, last_used_at, revoked_at`.
  Same SQLite→Postgres naming rule as `db.mjs` (replay DDL with `AUTOINCREMENT → SERIAL` at P5).
- **Key format:** `agk_live_` + base64url(24 random bytes). **Only `SHA-256(key)` is stored.**
  The plaintext is returned exactly once, at creation — the Connect page shows it once with a
  Copy button and never again. Prefix (first 12 chars) is stored for identification.
- **Functions:** `initApiKeys(db)`, `createApiKey(db, {name, scopes, agentId})`,
  `listApiKeys(db)` (no hashes, no plaintext), `revokeApiKey(db, id)`,
  `verifyApiKey(db, key)` (updates `last_used_at`), `authenticateApiKey(db, key, masterKey)`,
  `hasScope(auth, scope)`.
- **New Core endpoints** (wiring §6, master key only — `keys:manage`):
  - `POST /api/keys` `{name, scopes?, agentId?}` → `201 { id, name, key, keyPrefix, scopes, … }` (key shown once)
  - `GET /api/keys` → list, masked (prefix only, `revoked` flag, `last_used_at`)
  - `DELETE /api/keys/:id` → revoke (sets `revoked_at`; row kept for audit)
- **Audit:** key creation/revocation should append `key.created` / `key.revoked` rows to the
  `events` table via the existing `appendEvent` path (one line each in the route handlers).

## 5. Connect page changes (`web/index.html` — wiring §6, NOT edited yet)

1. **"API keys" card** directly under the matrix (after L518): a form (name + scope checkboxes
   + optional agent) → `POST /api/keys` with `CORE.key` → success box shows the key once + Copy
   button + "save it now, it will never be shown again" warning → table of existing keys
   (prefix, scopes, agent, created, last used, Revoke button → `DELETE /api/keys/:id`).
2. **"Connect via MCP" card:** two tabs — *Local (Claude Code)* with the `claude mcp add …`
   command + Copy; *Remote (HTTP)* with the `claude_desktop_config.json` snippet, the key field
   prefilled from a key the owner just created. Live status line under it: `GET /api/state`
   → count of `connections` rows with `method='MCP'` and `status='Connected'`.
3. **Matrix goes live:** `renderConnectLive()` (L1054) already repaints from `/api/state` — no
   change needed once MCP events mark the row `Connected` (§3). The hardcoded `CONNECT_STATUS`
   seed stays only as the first-run fallback.

## 6. Wiring checklist (exact edits — NOT done yet, needs go-ahead §8)

1. `core/src/server.mjs` — call `initApiKeys(db)` right after `seed()` (done this way instead
   of inside `db.mjs seed()` to avoid a circular import: `api-keys.mjs` already imports `now`
   from `db.mjs`). The MCP stdio server calls it too, in its own startup path.
2. `core/src/server.mjs` —
   - import `{ initApiKeys, authenticateApiKey, hasScope, createApiKey, listApiKeys, revokeApiKey }` and
     `{ handleMcpHttp }` from `./mcp-server.mjs`; call `initApiKeys(db)` next to `seed()`.
   - add `POST /mcp` → `handleMcpHttp(req, res, { masterKey: API_KEY })` in the router.
   - add the three `/api/keys` routes (master key only).
   - replace the three `req.headers['x-api-key'] !== API_KEY` checks with
     `authenticateApiKey()` + per-route scope (`events:write`, `handovers:write`, `chat:write`).
     Master key keeps passing everywhere, so existing clients (emit CLI, frontend) do not break.
3. `core/package.json` — scripts only, no new deps:
   `"mcp": "node src/mcp-server.mjs --stdio"`, `"start:mcp-http": "node src/server.mjs"` (unchanged).
4. `web/index.html` — the two cards from §5 (insert after the matrix `</div>`, L518).
5. `docs/MASTER-PLAN.md` §8 — add a row: **P2.5 — MCP + API keys | 🔄 this design | MCP server + key creation + live Connect page**.

## 7. Follow-up refactor (after this lands — do not block on it)

`server.mjs` (`handleAdapterEvent`, `getState`, `claudeReply`, `advanceHandover`) and
`mcp-server.mjs` (`emitEvent`, `getStateSnapshot`, `chatReply`, `advanceHandover`) currently
implement the same Core semantics twice — deliberately, so the MCP server never imports
`server.mjs` (which starts the HTTP listener on import). The clean fix: extract the shared
logic into `core/src/core-api.mjs` and have both servers import it. One file, one behaviour.

## 8. Safety + what was NOT done

- **Nothing was run.** No `npm install`, no `node`, no `git` command inside the repo, no edit to
  any existing file. Only two NEW files (`core/src/api-keys.mjs`, `core/src/mcp-server.mjs`)
  and this design doc were written. The clone earlier flagged an execution-risk check, so
  **wiring (§6) + running + testing needs Jafrul's explicit go-ahead in plain words.**
- **No secrets** in any new file. Keys are hashed; the master key stays env-only.
- **No new dependency.** MCP is hand-rolled JSON-RPC 2.0; `ws` remains the only dep.

## 8b. Fixes found during local testing (2026-11-27)

- `core/src/db.mjs`: a fresh clone has no `core/data/` dir, so `new DatabaseSync()` threw
  `unable to open database file` and the server would not start at all. Fixed: `mkdirSync(..., {recursive: true})`
  before opening the DB.
- `core/src/mcp-server.mjs`: the stdio transport crashed with an unhandled EPIPE when the
  client closed the pipe early (e.g. piping to `head`). Fixed: a `process.stdout.on('error')`
  guard — exit 0 on EPIPE.
- §9 verification results (local, `AGENTIC_API_KEY=dev-key`, port 4310): health 200; stdio
  initialize → protocol 2025-03-26 + 7 tools; `POST /api/keys` → 201 `agk_live_…`; MCP HTTP
  heartbeat → event id 2; `/api/state` → Muse `last_seen` fresh, `(Muse, MCP)` = Connected;
  read-only key emit → `isError: insufficient scope`; revoke → retry 401; master-key REST
  events still work; wrong key on `/api/keys` → 401. All passed.
- Root 404 fix (2026-11-27 18:52 +06, Jafrul reported `{"error":"not found"}` on os.ecomex.cloud):
  `GET /` had no route, so browsers saw the generic 404. Fixed in `server.mjs`: browsers
  (Accept: text/html) get a 302 redirect to the Vercel dashboard; API clients get a 200 JSON
  status doc; unknown paths now return 404 with a `hint`. Verified locally: `/` → 200 JSON,
  HTML → 302 to Vercel, `/nope` → 404+hint, health/keys/MCP regression all pass. NOT live yet —
  production still runs the old code until deployed.

## 9. Verification checklist (run after the §6 wiring, with go-ahead)

```bash
# 1. stdio handshake (local, no key)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/mcp-server.mjs --stdio
# expect: protocolVersion 2025-03-26, serverInfo agentic-os-core, 7 tools

# 2. create a key (master key only)
curl -s -X POST https://os.ecomex.cloud/api/keys \
  -H 'x-api-key: <MASTER>' -H 'content-type: application/json' \
  -d '{"name":"claude-code-local","scopes":["state:read","events:write"]}'
# expect: 201 + key agk_live_… (shown once — save it)

# 3. use the new key over MCP HTTP
curl -s -X POST https://os.ecomex.cloud/mcp -H 'x-api-key: agk_live_…' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"agentic_emit_event","arguments":{"agentId":"Muse","type":"heartbeat"}}}'
# expect: 200 + event row

# 4. confirm on the board
curl -s https://os.ecomex.cloud/api/state | python3 -c "import json,sys; s=json.load(sys.stdin); print([a['id'] for a in s['agents'] if a['status']=='Connected']); print(s['connections'][:2])"
# expect: Muse last_seen = now, connections row (Muse, MCP) = Connected

# 5. revoke
curl -s -X DELETE https://os.ecomex.cloud/api/keys/<id> -H 'x-api-key: <MASTER>'
# expect: 200; step 3 with the same key then returns 401
```

## 10. The other way to create an API connection (already working today)

Separately from the repo, a Muse-side connector already exists: **`custom.agentic-os`**
(API key, header `x-api-key`, host `os.ecomex.cloud`) — set up 2026-11-27 when Jafrul asked
to connect Muse to the OS. Once the production key is entered there, any Muse session can call
the Core API through it. That is the *external* way to create an API connection; §4 is the
*in-OS* way (Jafrul creates keys himself from the Connect page, per key, per scope, revocable).

## 11. Open questions (owner-only, not blocking)

1. Should MCP over HTTP accept the master key, or per-key keys only? (Design default: both —
   master for the owner, per-key for everyone else.)
2. Should key creation require anything beyond the master key (e.g. a second owner confirm)?
   Design default: master key only — it already proves owner access to the VPS.
3. Postgres (P5) keeps the same `api_keys` table/columns; key hashes migrate as-is.
