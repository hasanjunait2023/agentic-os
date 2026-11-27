// Agentic OS Core — HTTP REST + WebSocket server (P2)
//
// One port (default 4310, env PORT) serves both the REST API and the
// WebSocket live stream at /ws. Every mutation appends to the event store
// and is broadcast to all connected UI clients.
//
// Adapter ingest (POST /api/events) requires header `x-api-key` matching
// env AGENTIC_API_KEY (default `dev-key` — DEV ONLY, see README).

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { db, seed, brainSummary, now } from './db.mjs';

const PORT = Number(process.env.PORT ?? 4310);
const API_KEY = process.env.AGENTIC_API_KEY ?? 'dev-key';

seed();

// ---------------------------------------------------------------------------
// Small query helpers
// ---------------------------------------------------------------------------
const q = {
  agents:      () => db.prepare('SELECT * FROM agents ORDER BY id').all(),
  projects:    () => db.prepare('SELECT * FROM projects ORDER BY id').all(),
  phases:      () => db.prepare('SELECT * FROM phases ORDER BY project_id, position').all(),
  tasks:       () => db.prepare('SELECT * FROM tasks ORDER BY id').all(),
  handovers:   () => db.prepare('SELECT * FROM handovers ORDER BY id').all(),
  connections: () => db.prepare('SELECT * FROM connections ORDER BY agent_id, id').all(),
  knowledge:   () => db.prepare('SELECT * FROM knowledge_nodes ORDER BY link_count DESC').all(),
  events:      (n = 50) => db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(n)
    .map(e => ({ ...e, payload: JSON.parse(e.payload) })),
  agent:       (id) => db.prepare('SELECT * FROM agents WHERE id = ?').get(id),
  task:        (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id),
  handover:    (id) => db.prepare('SELECT * FROM handovers WHERE id = ?').get(id),
};

export function getState() {
  return {
    agents: q.agents(),
    projects: q.projects(),
    phases: q.phases(),
    tasks: q.tasks(),
    handovers: q.handovers(),
    connections: q.connections(),
    knowledgeNodes: q.knowledge(),
    brain: brainSummary(),
    events: q.events(50),
  };
}

function appendEvent(agentId, type, payload) {
  const ts = now();
  const info = db.prepare('INSERT INTO events (ts, agent_id, type, payload) VALUES (?, ?, ?, ?)')
    .run(ts, agentId ?? null, type, JSON.stringify(payload ?? {}));
  return { id: Number(info.lastInsertRowid), ts, agent_id: agentId ?? null, type, payload: payload ?? {} };
}

// ---------------------------------------------------------------------------
// WebSocket fan-out
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

// Every mutation goes through here: event store + WS broadcast together.
function emit(agentId, type, payload, patch) {
  const event = appendEvent(agentId, type, payload);
  broadcast({ type: 'event', event });
  if (patch) broadcast({ type: 'state.patch', patch });
  return event;
}

// ---------------------------------------------------------------------------
// Adapter event handling (Generic Adapter Protocol — MASTER-PLAN §4)
// ---------------------------------------------------------------------------
const EVENT_TYPES = ['heartbeat', 'task.started', 'task.progress', 'task.done', 'task.blocked', 'chat.message'];

function handleAdapterEvent(body) {
  const { agentId, type, taskTitle, projectId, progress, note } = body ?? {};
  if (!agentId || !EVENT_TYPES.includes(type)) {
    return { error: `agentId required; type must be one of ${EVENT_TYPES.join(', ')}`, status: 400 };
  }
  const agent = q.agent(agentId);
  if (!agent) return { error: `unknown agent: ${agentId}`, status: 404 };
  const ts = now();
  const patch = {};

  if (type === 'heartbeat') {
    db.prepare('UPDATE agents SET last_seen = ?, status = ? WHERE id = ?')
      .run(ts, agent.status === 'offline' ? 'online' : agent.status, agentId);
    patch.agents = [q.agent(agentId)];
  }

  if (type.startsWith('task.') && taskTitle) {
    // Find this agent's open task with the same title, else create it.
    let task = db.prepare(`SELECT * FROM tasks WHERE owner = ? AND title = ? AND status NOT IN ('done') ORDER BY id DESC`)
      .get(agentId, taskTitle);
    if (!task) {
      const info = db.prepare(`INSERT INTO tasks (title, project_id, owner, status, progress, note, created_at, updated_at)
                               VALUES (?, ?, ?, 'running', 0, ?, ?, ?)`)
        .run(taskTitle, projectId ?? null, agentId, note ?? null, ts, ts);
      task = q.task(Number(info.lastInsertRowid));
    }
    const status = type === 'task.done' ? 'done' : type === 'task.blocked' ? 'blocked' : 'running';
    const newProgress = type === 'task.done' ? 100
      : (typeof progress === 'number' ? Math.max(0, Math.min(100, progress)) : task.progress);
    db.prepare('UPDATE tasks SET status = ?, progress = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?')
      .run(status, newProgress, note ?? null, ts, task.id);
    task = q.task(task.id);
    patch.tasks = [task];

    // Keep the agent's "current task" pointer in sync.
    if (status === 'running') {
      db.prepare('UPDATE agents SET current_task = ?, current_task_id = ?, progress = ?, last_seen = ? WHERE id = ?')
        .run(task.title, task.id, newProgress, ts, agentId);
    }
    patch.agents = [q.agent(agentId)];
  }

  if (type === 'chat.message' && typeof body.message === 'string') {
    db.prepare('INSERT INTO chat_messages (agent_id, role, text, ts) VALUES (?, ?, ?, ?)')
      .run(agentId, 'agent', body.message, ts);
  }

  const event = emit(agentId, type, body, patch);
  return { event, status: 201 };
}

// ---------------------------------------------------------------------------
// Handovers — pending → sent → accepted → running → completed.
// On `accepted`, task ownership moves to the target agent (no duplicate work).
// ---------------------------------------------------------------------------
const HO_FLOW = ['pending', 'sent', 'accepted', 'running', 'completed'];

function advanceHandover(id) {
  const ho = q.handover(id);
  if (!ho) return { error: 'handover not found', status: 404 };
  const idx = HO_FLOW.indexOf(ho.status);
  if (idx === HO_FLOW.length - 1) return { error: 'handover already completed', status: 409 };
  const next = HO_FLOW[idx + 1];
  const ts = now();
  let taskId = ho.task_id;
  const patch = {};

  if (next === 'accepted') {
    if (!taskId) {
      // No linked task yet — create it, owned by the receiving agent.
      const info = db.prepare(`INSERT INTO tasks (title, project_id, owner, status, progress, note, created_at, updated_at)
                               VALUES (?, 'agentic-os', ?, 'queued', 0, ?, ?, ?)`)
        .run(ho.title, ho.to_agent, ho.note, ts, ts);
      taskId = Number(info.lastInsertRowid);
    } else {
      db.prepare('UPDATE tasks SET owner = ?, updated_at = ? WHERE id = ?').run(ho.to_agent, ts, taskId);
    }
    patch.tasks = [q.task(taskId)];
  }
  if (next === 'running' && taskId) {
    db.prepare(`UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`).run(ts, taskId);
    patch.tasks = [q.task(taskId)];
  }
  if (next === 'completed' && taskId) {
    db.prepare(`UPDATE tasks SET status = 'done', progress = 100, updated_at = ? WHERE id = ?`).run(ts, taskId);
    patch.tasks = [q.task(taskId)];
  }

  db.prepare('UPDATE handovers SET status = ?, task_id = ?, updated_at = ? WHERE id = ?').run(next, taskId, ts, id);
  const updated = q.handover(id);
  patch.handovers = [updated];
  emit(ho.to_agent, `handover.${next}`, { handoverId: id, title: ho.title, from: ho.from_agent, to: ho.to_agent, taskId }, patch);
  return { handover: updated, status: 200 };
}

// ---------------------------------------------------------------------------
// Chat — Muse replies from REAL state (rule-based, no LLM in P2).
// Other agents are not live yet (P3), so their reply is an honest "queued".
// ---------------------------------------------------------------------------
function claudeReply(message) {
  const running = db.prepare(`SELECT * FROM tasks WHERE owner = 'Muse' AND status = 'running' ORDER BY progress DESC`).all();
  const blocked = db.prepare(`SELECT * FROM tasks WHERE status = 'blocked'`).all();
  const brain = brainSummary();
  const m = message.toLowerCase();

  if (m.includes('brain') || m.includes('note')) {
    return brain
      ? `The shared Second Brain is synced: ${brain.notes.toLocaleString()} notes, ${brain.edges.toLocaleString()} wikilinks, only ${brain.orphans} orphans. Biggest hub right now is hostinger-vps. I read INDEX first, then the exact notes a task needs — and I write back after every meaningful task.`
      : 'The Second Brain stats file is not available to the core right now.';
  }
  if (m.includes('block')) {
    return blocked.length
      ? `Currently blocked: ${blocked.map(t => `"${t.title}" (${t.note ?? 'no note'})`).join('; ')}. Everything else is moving.`
      : 'Nothing is blocked right now.';
  }
  if (m.includes('project')) {
    const ps = q.projects().map(p => `${p.name} ${p.progress}% (${p.status})`).join(' · ');
    return `Project roll-up from live state: ${ps}.`;
  }
  // Default: status report built from the running task list.
  const lines = running.map(t => `"${t.title}" at ${t.progress}%`).join('; ');
  return `Status from my live task list — I am running ${running.length} tasks right now: ${lines || 'none'}. ` +
    `Projects: ${q.projects().map(p => `${p.name} ${p.progress}%`).join(' · ')}. ` +
    (brain ? `Second Brain: ${brain.notes.toLocaleString()} notes / ${brain.edges.toLocaleString()} links, synced. ` : '') +
    `Tell me a task and I will log it as an event.`;
}

function handleChat(agentId, message) {
  const agent = q.agent(agentId);
  if (!agent) return { error: `unknown agent: ${agentId}`, status: 404 };
  if (typeof message !== 'string' || !message.trim()) return { error: 'message required', status: 400 };
  const ts = now();
  db.prepare('INSERT INTO chat_messages (agent_id, role, text, ts) VALUES (?, ?, ?, ?)').run(agentId, 'user', message, ts);

  const reply = agentId === 'Muse'
    ? claudeReply(message)
    : `Queued for ${agent.name} — this agent is not live yet (its adapter lands in P3). Your message is stored in the core and will be delivered when ${agent.name} connects. Current status: ${agent.status}; last known task: "${agent.current_task}".`;

  db.prepare('INSERT INTO chat_messages (agent_id, role, text, ts) VALUES (?, ?, ?, ?)').run(agentId, 'agent', reply, ts);
  emit(agentId, 'chat.message', { from: 'user', message }, null);
  emit(agentId, 'chat.reply', { reply }, null);
  return { reply, status: 200 };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-api-key', 'access-control-allow-methods': 'GET, POST, OPTIONS' }); return res.end(); }
    if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, ts: now() });
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, getState());

    if (req.method === 'POST' && path === '/api/events') {
      if (req.headers['x-api-key'] !== API_KEY) return json(res, 401, { error: 'invalid or missing x-api-key' });
      const { error, status, event } = handleAdapterEvent(await readBody(req));
      return error ? json(res, status, { error }) : json(res, status, { ok: true, event });
    }

    if (req.method === 'POST' && path === '/api/handovers') {
      if (req.headers['x-api-key'] !== API_KEY) return json(res, 401, { error: 'invalid or missing x-api-key' });
      const body = await readBody(req);
      const { title, toAgent, fromAgent = 'Muse', note = '' } = body ?? {};
      if (!title || !toAgent) return json(res, 400, { error: 'title and toAgent required' });
      const ts = now();
      const info = db.prepare(`INSERT INTO handovers (title, from_agent, to_agent, note, status, created_at, updated_at)
                               VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
        .run(title, fromAgent, toAgent, note, ts, ts);
      const handover = q.handover(Number(info.lastInsertRowid));
      emit(fromAgent, 'handover.created', { handoverId: handover.id, title, to: toAgent }, { handovers: [handover] });
      return json(res, 201, { ok: true, handover });
    }

    const adv = path.match(/^\/api\/handovers\/(\d+)\/advance$/);
    if (req.method === 'POST' && adv) {
      if (req.headers['x-api-key'] !== API_KEY) return json(res, 401, { error: 'invalid or missing x-api-key' });
      const { error, status, handover } = advanceHandover(Number(adv[1]));
      return error ? json(res, status, { error }) : json(res, status, { ok: true, handover });
    }

    const chat = path.match(/^\/api\/chat\/([\w-]+)$/);
    if (req.method === 'POST' && chat) {
      if (req.headers['x-api-key'] !== API_KEY) return json(res, 401, { error: 'invalid or missing x-api-key' });
      const body = await readBody(req);
      const { error, status, reply } = handleChat(chat[1], body?.message);
      return error ? json(res, status, { error }) : json(res, status, { ok: true, reply });
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    return json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'snapshot', state: getState() }));
  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: now() }));
    } catch { /* non-JSON frames ignored */ }
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`Agentic OS Core listening on http://localhost:${PORT}  (REST + ws://localhost:${PORT}/ws)`);
  if (API_KEY === 'dev-key') console.log('WARNING: using default dev API key — set AGENTIC_API_KEY in production.');
});
