// Agentic OS Core — database layer (P2)
//
// Uses Node's built-in node:sqlite (DatabaseSync). The schema deliberately
// mirrors the PostgreSQL design in docs/MASTER-PLAN.md — same table and
// column names — so the P5 VPS deploy can migrate to Postgres by replaying
// this DDL with type swaps (TEXT/INTEGER stay valid; AUTOINCREMENT -> SERIAL).
//
// DB file: core/data/agentic-os.db (gitignored). Seeding is idempotent:
// seed() only inserts when the target table is empty.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = join(here, '..', 'data', 'agentic-os.db');
const BRAIN_STATS_PATH = join(here, '..', '..', 'brain', 'stats.json');

// Fresh clones have no data/ dir yet — SQLite cannot create the file
// without it, so create the directory first (found during local testing).
mkdirSync(join(here, '..', 'data'), { recursive: true });
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS agents (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    type           TEXT,
    role           TEXT,
    status         TEXT NOT NULL DEFAULT 'offline',
    current_task   TEXT,
    current_task_id INTEGER,
    method         TEXT,              -- primary connection method (display)
    adapter_type   TEXT,
    progress       INTEGER NOT NULL DEFAULT 0,
    capabilities   TEXT,              -- JSON array
    last_seen      TEXT               -- ISO timestamp of last heartbeat
  );

  CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    tag         TEXT,
    status      TEXT,
    progress    INTEGER NOT NULL DEFAULT 0,
    next_step   TEXT,
    owner_agent TEXT,
    health      TEXT
  );

  CREATE TABLE IF NOT EXISTS phases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title      TEXT NOT NULL,
    detail     TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',  -- done | active | pending
    position   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id),
    owner      TEXT REFERENCES agents(id),       -- agent_id that owns the work
    status     TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | blocked
    progress   INTEGER NOT NULL DEFAULT 0,
    note       TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS handovers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent   TEXT NOT NULL,
    note       TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',  -- pending|sent|accepted|running|completed
    task_id    INTEGER REFERENCES tasks(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Append-only event store: every adapter event lands here, never updated.
  CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    agent_id TEXT,
    type     TEXT NOT NULL,
    payload  TEXT NOT NULL              -- JSON
  );

  CREATE TABLE IF NOT EXISTS connections (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    method   TEXT NOT NULL,
    status   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_nodes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    folder     TEXT,
    link_count INTEGER NOT NULL DEFAULT 0,
    vault_path TEXT
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    role     TEXT NOT NULL,              -- 'user' | 'agent'
    text     TEXT NOT NULL,
    ts       TEXT NOT NULL
  );
`);

export const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Seed data — identical inventory to the P1/P1.5 frontend (web/index.html).
// ---------------------------------------------------------------------------

const AGENTS = [
  { id: 'Muse',      name: 'Muse',       type: 'orchestrator', role: 'Orchestrator',            status: 'Connected',       method: 'Live session (this app)', adapter_type: 'native',    progress: 70, current_task: 'Building the full-screen Agentic OS pages (v2)',          capabilities: ['orchestration', 'code', 'research', 'video'] },
  { id: 'claude-code', name: 'Claude Code',  type: 'code',         role: 'Code agent',              status: 'Standby',         method: 'CLI bridge',              adapter_type: 'cli',       progress: 35, current_task: 'Solixoo verification support — on call',               capabilities: ['code', 'tests', 'review'] },
  { id: 'hermes',      name: 'Hermes Agent', type: 'automation',   role: 'Automation agent',        status: 'Bridge ready',    method: 'n8n bridge',              adapter_type: 'n8n',       progress: 50, current_task: 'Watching the n8n Agent Hub queue',                     capabilities: ['automation', 'workflows', 'monitoring'] },
  { id: 'dot',         name: 'Dot Agent',    type: 'research',     role: 'Research agent (OpenAI)', status: 'Via n8n Agent Hub', method: 'n8n bridge',           adapter_type: 'n8n',       progress: 20, current_task: 'Agent Hub queue — connection test queued',              capabilities: ['research', 'web'] },
  { id: 'codex',       name: 'Codex',        type: 'code',         role: 'Coding agent (OpenAI)',   status: 'Via n8n Agent Hub', method: 'n8n bridge',           adapter_type: 'n8n',       progress: 20, current_task: 'Agent Hub queue — connection test queued',              capabilities: ['code', 'review', 'automation'] },
];

const PROJECTS = [
  { id: 'solixoo',    name: 'Solixoo',                    tag: 'Garments SaaS', status: 'Verification wave running',       progress: 55, next_step: 'S0 redesign foundation',        owner_agent: 'Muse', health: 'good' },
  { id: 'iip',        name: 'IIP — Impact Investment PLC', tag: 'Brand reels',  status: 'Reel v4 built with HyperFrames',  progress: 67, next_step: 'Reel series production',        owner_agent: 'Muse', health: 'good' },
  { id: 'agentic-os', name: 'Agentic OS',                 tag: 'This system',   status: 'Full-screen multi-page UI (v2)',    progress: 28, next_step: 'P2 — real WebSocket core',      owner_agent: 'Muse', health: 'good' },
];

// [project_id, title, detail, status]
const PHASES = [
  ['solixoo', 'Foundation & core modules', 'Done · panels, orders, costing', 'done'],
  ['solixoo', 'Fix Wave 1', 'Done', 'done'],
  ['solixoo', 'Fix Wave 2', 'Done · commit e28fb44 · 990/990 tests', 'done'],
  ['solixoo', 'Fix Wave 3', 'Done · commit af74e31 · 998/998 tests', 'done'],
  ['solixoo', 'Verification wave', 'Active now · independent checks before redesign', 'active'],
  ['solixoo', 'S0 redesign foundation', 'Pending · design tokens, light/dark theme, new shell', 'pending'],
  ['iip', 'Brand & Facebook page analysis', 'Done · @iip.invest · dark green + gold', 'done'],
  ['iip', 'Reference reel study', 'Done · reference matched frame by frame', 'done'],
  ['iip', 'Reel v4 — HyperFrames build', 'Active · built with the installed skill toolchain', 'active'],
  ['agentic-os', 'P0 — Master plan', 'Done · domain model, adapter protocol, phases', 'done'],
  ['agentic-os', 'P1 — Prototype + Second Brain', 'Done · Crextio UI, live on Vercel, brain graph connected', 'done'],
  ['agentic-os', 'P1.5 — Full-screen multi-page UI', 'Active now · separate page per section, agent chat, team hierarchy', 'active'],
  ['agentic-os', 'P2 — Real core', 'Pending · WebSocket server, event store, live agent link', 'pending'],
];

// [title, project_id, owner, status, progress, note]
const TASKS = [
  ['Solixoo Fix Wave 2', 'solixoo', 'Muse', 'done', 100, '990/990 tests'],
  ['Solixoo Fix Wave 3', 'solixoo', 'Muse', 'done', 100, '998/998 tests'],
  ['Second Brain graph pipeline', 'agentic-os', 'Muse', 'done', 100, '2,851 links parsed'],
  ['Shared Brain Protocol', 'agentic-os', 'Muse', 'done', 100, 'All agents'],
  ['IIP brand & page analysis', 'iip', 'Muse', 'done', 100, '@iip.invest'],
  ['Agentic OS master plan (P0)', 'agentic-os', 'Muse', 'done', 100, ''],
  ['Full-screen multi-page OS frontend', 'agentic-os', 'Muse', 'running', 70, 'Frontend Builder'],
  ['Solixoo verification wave', 'solixoo', 'Muse', 'running', 45, 'Dev Lead'],
  ['IIP reel v4 polish', 'iip', 'Muse', 'running', 80, 'Video Team'],
  ['Brain graph in OS Brain view', 'agentic-os', 'Muse', 'running', 90, 'Brain Sync'],
  ['P2 — real WebSocket core', 'agentic-os', 'Muse', 'queued', 0, 'After UI approval'],
  ['S0 redesign foundation (Solixoo)', 'solixoo', 'Muse', 'queued', 0, 'After verification'],
  ['Hermes & Dot live adapters (P3)', 'agentic-os', 'Muse', 'blocked', 0, 'Needs how-you-run-them info'],
];

// [title, from_agent, to_agent, note, status, linked task title (nullable)]
const HANDOVERS = [
  ['Verify Solixoo consumption calculator', 'Muse', 'claude-code', 'Re-check the calculator against Wave 3 fixes before S0.', 'completed', null],
  ['Run n8n Agent Hub health check', 'Muse', 'hermes', 'Confirm both Agent Hub workflows are active and report tool count.', 'completed', null],
  ['Review IIP reel v4 render', 'Muse', 'hermes', 'Compare v4 against the reference reel; flag any frame that drifts.', 'running', 'IIP reel v4 polish'],
  ['Research competitor dashboards', 'Muse', 'dot', 'Collect 5 strong dashboard references with screenshots and notes.', 'accepted', null],
  ['Refresh Brain graph after vault update', 'Muse', 'claude-code', 'Re-run the graph build after the next vault snapshot lands.', 'sent', null],
];

// 11 connection methods × 4 agents — same matrix as the Connect page.
const CONNECT_METHODS = ['REST API + key', 'MCP', 'CLI bridge', 'Webhook', 'WebSocket', 'Log watcher', 'File / folder bridge', 'SSH', 'Browser session', 'n8n bridge', 'Manual copy-paste'];
const CONNECT_STATUS = {
  'Muse':      ['Connected', 'Connected', 'Connected', 'Ready', 'Planned (P2)', 'Ready', 'Connected', 'Ready', 'Ready', 'Connected', 'Available'],
  'claude-code': ['Ready', 'Ready', 'Connected', 'Ready', 'Planned (P2)', 'Ready', 'Ready', 'Ready', '—', 'Ready', 'Available'],
  'hermes':      ['Ready', 'Ready', 'Ready', 'Connected', 'Planned (P2)', 'Ready', 'Ready', '—', 'Ready', 'Connected', 'Available'],
  'dot':         ['Ready', '—', '—', 'Ready', 'Planned (P2)', '—', 'Ready', '—', 'Ready', 'Connected', 'Available'],
  'codex':       ['Ready', 'Ready', '—', 'Ready', 'Planned (P2)', '—', 'Ready', '—', 'Ready', 'Connected', 'Available'],
};

function tableEmpty(table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 0;
}

export function seed() {
  const ts = now();

  if (tableEmpty('agents')) {
    const ins = db.prepare(`INSERT INTO agents (id, name, type, role, status, current_task, method, adapter_type, progress, capabilities, last_seen)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const a of AGENTS) ins.run(a.id, a.name, a.type, a.role, a.status, a.current_task, a.method, a.adapter_type, a.progress, JSON.stringify(a.capabilities), ts);
  }

  if (tableEmpty('projects')) {
    const ins = db.prepare(`INSERT INTO projects (id, name, tag, status, progress, next_step, owner_agent, health) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of PROJECTS) ins.run(p.id, p.name, p.tag, p.status, p.progress, p.next_step, p.owner_agent, p.health);
  }

  if (tableEmpty('phases')) {
    const ins = db.prepare(`INSERT INTO phases (project_id, title, detail, status, position) VALUES (?, ?, ?, ?, ?)`);
    PHASES.forEach(([pid, title, detail, status], i) => ins.run(pid, title, detail, status, i));
  }

  if (tableEmpty('tasks')) {
    const ins = db.prepare(`INSERT INTO tasks (title, project_id, owner, status, progress, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [title, pid, owner, status, progress, note] of TASKS) ins.run(title, pid, owner, status, progress, note, ts, ts);
  }

  if (tableEmpty('handovers')) {
    const ins = db.prepare(`INSERT INTO handovers (title, from_agent, to_agent, note, status, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const findTask = db.prepare(`SELECT id FROM tasks WHERE title = ?`);
    for (const [title, from, to, note, status, taskTitle] of HANDOVERS) {
      const taskId = taskTitle ? (findTask.get(taskTitle)?.id ?? null) : null;
      ins.run(title, from, to, note, status, taskId, ts, ts);
    }
  }

  if (tableEmpty('connections')) {
    const ins = db.prepare(`INSERT INTO connections (agent_id, method, status) VALUES (?, ?, ?)`);
    for (const [agentId, statuses] of Object.entries(CONNECT_STATUS)) {
      statuses.forEach((status, i) => ins.run(agentId, CONNECT_METHODS[i], status));
    }
  }

  if (tableEmpty('knowledge_nodes')) {
    // Top-30 hubs from the real Second Brain graph build (brain/stats.json).
    try {
      const stats = JSON.parse(readFileSync(BRAIN_STATS_PATH, 'utf8'));
      const ins = db.prepare(`INSERT INTO knowledge_nodes (title, folder, link_count, vault_path) VALUES (?, ?, ?, ?)`);
      for (const hub of (stats.hubs ?? []).slice(0, 30)) {
        ins.run(hub.title, hub.folder, hub.degree, hub.folder === '(root)' ? `${hub.title}.md` : `${hub.folder}/${hub.title}.md`);
      }
    } catch { /* brain stats not present — knowledge layer seeds later via sync */ }
  }
}

// Brain summary for /api/state — read live from the graph build output.
export function brainSummary() {
  if (!existsSync(BRAIN_STATS_PATH)) return null;
  try {
    const s = JSON.parse(readFileSync(BRAIN_STATS_PATH, 'utf8'));
    return { notes: s.notes, nodes: s.nodes, edges: s.edges, orphans: s.orphans, folders: s.folders };
  } catch { return null; }
}
