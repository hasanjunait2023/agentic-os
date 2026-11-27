#!/usr/bin/env node
// Agentic OS Core — MCP server (Model Context Protocol, zero-dependency)
//
// Exposes the Core to any MCP client (Claude Code, Claude Desktop, any
// MCP-compatible agent) so it can observe the board and report work — the
// same Generic Adapter Protocol as REST (MASTER-PLAN §4), over MCP tools.
//
// Transports (MCP 2025-03-26, also accepts 2024-11-05):
//   stdio:  node src/mcp-server.mjs --stdio
//           Local agents on the same machine (Claude Code). No key needed —
//           same-machine trust, exactly like the CLI bridge.
//   HTTP:   POST /mcp on the Core (Streamable HTTP). Mounted by server.mjs
//           via handleMcpHttp() — requires header x-api-key (master key or
//           a per-key key from api-keys.mjs, scope-checked per tool).
//
// No new dependencies: the MCP protocol is plain JSON-RPC 2.0, implemented
// here by hand because core/package.json intentionally stays minimal
// (only `ws`). If the team later adopts @modelcontextprotocol/sdk, this
// file's TOOLS table is the spec to port — the tool names and shapes stay.
//
// Tools map 1:1 onto the Core (see docs/MCP-API-CONNECTION-DESIGN.md §3).
// State reads and event writes share the same SQLite DB as server.mjs
// (WAL mode), so MCP activity shows up in /api/state and the dashboard
// WebSocket feed without any extra sync step.

import readline from 'node:readline';
import { db, seed, brainSummary, now } from './db.mjs';
import { initApiKeys, authenticateApiKey, hasScope, SCOPES } from './api-keys.mjs';

export const SERVER_INFO = { name: 'agentic-os-core', version: '0.2.0' };
const PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL = '2025-03-26';
const EVENT_TYPES = ['heartbeat', 'task.started', 'task.progress', 'task.done', 'task.blocked', 'chat.message'];
const HO_FLOW = ['pending', 'sent', 'accepted', 'running', 'completed'];

// ---------------------------------------------------------------------------
// State + event logic — same semantics as server.mjs handleAdapterEvent /
// getState. Kept in this file so the MCP server never imports server.mjs
// (which starts the HTTP listener on import). Follow-up refactor (design
// doc §7): extract both into core/src/core-api.mjs as the single source.
// ---------------------------------------------------------------------------

function getStateSnapshot() {
  const events = db
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT 50')
    .all()
    .map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
  return {
    agents: db.prepare('SELECT * FROM agents ORDER BY id').all(),
    projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
    phases: db.prepare('SELECT * FROM phases ORDER BY project_id, position').all(),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
    handovers: db.prepare('SELECT * FROM handovers ORDER BY id').all(),
    connections: db.prepare('SELECT * FROM connections ORDER BY agent_id, id').all(),
    knowledgeNodes: db.prepare('SELECT * FROM knowledge_nodes ORDER BY link_count DESC').all(),
    brain: brainSummary(),
    events,
  };
}

function appendEvent(agentId, type, payload) {
  const ts = now();
  const info = db
    .prepare('INSERT INTO events (ts, agent_id, type, payload) VALUES (?, ?, ?, ?)')
    .run(ts, agentId ?? null, type, JSON.stringify(payload ?? {}));
  return { id: Number(info.lastInsertRowid), ts, agent_id: agentId ?? null, type, payload: payload ?? {} };
}

function markConnected(agentId, method) {
  db.prepare(`UPDATE connections SET status = 'Connected' WHERE agent_id = ? AND method = ?`).run(agentId, method);
}

function emitEvent({ agentId, type, taskTitle, projectId, progress, note, message }) {
  if (!agentId || !EVENT_TYPES.includes(type)) {
    throw new Error(`agentId required; type must be one of ${EVENT_TYPES.join(', ')}`);
  }
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  const ts = now();
  let task = null;

  if (type === 'heartbeat') {
    db.prepare('UPDATE agents SET last_seen = ?, status = ? WHERE id = ?').run(
      ts,
      agent.status === 'offline' ? 'online' : agent.status,
      agentId,
    );
  }

  if (type.startsWith('task.') && taskTitle) {
    task = db
      .prepare(
        `SELECT * FROM tasks WHERE owner = ? AND title = ? AND status NOT IN ('done') ORDER BY id DESC`,
      )
      .get(agentId, taskTitle);
    if (!task) {
      const info = db
        .prepare(
          `INSERT INTO tasks (title, project_id, owner, status, progress, note, created_at, updated_at)
           VALUES (?, ?, ?, 'running', 0, ?, ?, ?)`,
        )
        .run(taskTitle, projectId ?? null, agentId, note ?? null, ts, ts);
      task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(info.lastInsertRowid));
    }
    const status = type === 'task.done' ? 'done' : type === 'task.blocked' ? 'blocked' : 'running';
    const newProgress =
      type === 'task.done' ? 100 : typeof progress === 'number' ? Math.max(0, Math.min(100, progress)) : task.progress;
    db.prepare('UPDATE tasks SET status = ?, progress = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?').run(
      status,
      newProgress,
      note ?? null,
      ts,
      task.id,
    );
    task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
    if (status === 'running') {
      db.prepare('UPDATE agents SET current_task = ?, current_task_id = ?, progress = ?, last_seen = ? WHERE id = ?').run(
        task.title,
        task.id,
        newProgress,
        ts,
        agentId,
      );
    }
  }

  if (type === 'chat.message' && typeof message === 'string') {
    db.prepare('INSERT INTO chat_messages (agent_id, role, text, ts) VALUES (?, ?, ?, ?)').run(agentId, 'agent', message, ts);
  }

  markConnected(agentId, 'MCP');
  const event = appendEvent(agentId, type, { agentId, type, taskTitle, projectId, progress, note, message });
  return { event, task };
}

function createHandover({ title, toAgent, fromAgent = 'Muse', note = '' }) {
  if (!title || !toAgent) throw new Error('title and toAgent required');
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO handovers (title, from_agent, to_agent, note, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(title, fromAgent, toAgent, note, ts, ts);
  const handover = db.prepare('SELECT * FROM handovers WHERE id = ?').get(Number(info.lastInsertRowid));
  appendEvent(fromAgent, 'handover.created', { handoverId: handover.id, title, to: toAgent });
  return handover;
}

function advanceHandover(id) {
  const ho = db.prepare('SELECT * FROM handovers WHERE id = ?').get(id);
  if (!ho) throw new Error('handover not found');
  const idx = HO_FLOW.indexOf(ho.status);
  if (idx === HO_FLOW.length - 1) throw new Error('handover already completed');
  const next = HO_FLOW[idx + 1];
  const ts = now();
  let taskId = ho.task_id;
  if (next === 'accepted') {
    if (!taskId) {
      const info = db
        .prepare(
          `INSERT INTO tasks (title, project_id, owner, status, progress, note, created_at, updated_at)
           VALUES (?, 'agentic-os', ?, 'queued', 0, ?, ?, ?)`,
        )
        .run(ho.title, ho.to_agent, ho.note, ts, ts);
      taskId = Number(info.lastInsertRowid);
    } else {
      db.prepare('UPDATE tasks SET owner = ?, updated_at = ? WHERE id = ?').run(ho.to_agent, ts, taskId);
    }
  }
  if (next === 'running' && taskId) {
    db.prepare(`UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?`).run(ts, taskId);
  }
  if (next === 'completed' && taskId) {
    db.prepare(`UPDATE tasks SET status = 'done', progress = 100, updated_at = ? WHERE id = ?`).run(ts, taskId);
  }
  db.prepare('UPDATE handovers SET status = ?, task_id = ?, updated_at = ? WHERE id = ?').run(next, taskId, ts, id);
  const handover = db.prepare('SELECT * FROM handovers WHERE id = ?').get(id);
  appendEvent(ho.to_agent, `handover.${next}`, { handoverId: id, title: ho.title, from: ho.from_agent, to: ho.to_agent, taskId });
  return handover;
}

// Compact form of the rule-based Muse reply in server.mjs (same sources:
// running tasks, blocked tasks, brain stats, project roll-up).
function chatReply(agentId, message) {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
  if (!agent) throw new Error(`unknown agent: ${agentId}`);
  const ts = now();
  db.prepare('INSERT INTO chat_messages (agent_id, role, text, ts) VALUES (?, ?, ?, ?)').run(agentId, 'user', message, ts);
  let reply;
  if (agentId === 'Muse') {
    const running = db.prepare(`SELECT * FROM tasks WHERE owner = 'Muse' AND status = 'running' ORDER BY progress DESC`).all();
    const blocked = db.prepare(`SELECT * FROM tasks WHERE status = 'blocked'`).all();
    const brain = brainSummary();
    const m = message.toLowerCase();
    if (m.includes('block')) {
      reply = blocked.length
        ? `Currently blocked: ${blocked.map((t) => `"${t.title}" (${t.note ?? 'no note'})`).join('; ')}. Everything else is moving.`
        : 'Nothing is blocked right now.';
    } else if (m.includes('project')) {
      reply = `Project roll-up from live state: ${db
        .prepare('SELECT * FROM projects')
        .all()
        .map((p) => `${p.name} ${p.progress}% (${p.status})`)
        .join(' · ')}.`;
    } else {
      const lines = running.map((t) => `"${t.title}" at ${t.progress}%`).join('; ');
      reply =
        `Status from my live task list — I am running ${running.length} tasks right now: ${lines || 'none'}. ` +
        `Projects: ${db.prepare('SELECT * FROM projects').all().map((p) => `${p.name} ${p.progress}%`).join(' · ')}. ` +
        (brain ? `Second Brain: ${brain.notes.toLocaleString()} notes / ${brain.edges.toLocaleString()} links, synced. ` : '') +
        `Tell me a task and I will log it as an event.`;
    }
  } else {
    reply = `Queued for ${agent.name} — this agent is not live yet (its adapter lands in P3). Your message is stored in the core and will be delivered when ${agent.name} connects. Current status: ${agent.status}; last known task: "${agent.current_task}".`;
  }
  db.prepare('INSERT INTO chat_messages (agent_id, role, text, ts) VALUES (?, ?, ?, ?)').run(agentId, 'agent', reply, ts);
  appendEvent(agentId, 'chat.message', { from: 'user', message });
  appendEvent(agentId, 'chat.reply', { reply });
  return reply;
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

export const TOOLS = [
  {
    name: 'agentic_get_state',
    description: 'Read the whole Agentic OS board: agents, projects, phases, tasks, handovers, connections, brain stats, recent events.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'agentic_list_agents',
    description: 'List agents with status, current task, progress and last heartbeat.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'agentic_list_tasks',
    description: 'List tasks, optionally filtered by status, owner agent, or project.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'queued | running | done | blocked' },
        owner: { type: 'string', description: 'agent id, e.g. Muse' },
        projectId: { type: 'string', description: 'project id, e.g. solixoo' },
      },
      required: [],
    },
  },
  {
    name: 'agentic_emit_event',
    description: 'Report work to the Core (Generic Adapter Protocol): heartbeat, task.started, task.progress, task.done, task.blocked, chat.message. Creates or updates the agent task of the same title.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Exact agent id: Muse, claude-code, hermes, dot, codex' },
        type: { type: 'string', description: 'heartbeat | task.started | task.progress | task.done | task.blocked | chat.message' },
        taskTitle: { type: 'string' },
        projectId: { type: 'string' },
        progress: { type: 'number', description: '0-100' },
        note: { type: 'string' },
        message: { type: 'string', description: 'For chat.message' },
      },
      required: ['agentId', 'type'],
    },
  },
  {
    name: 'agentic_create_handover',
    description: 'Create a handover ticket to another agent: goal, context, definition of done. Ownership moves on accept.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        toAgent: { type: 'string', description: 'Exact agent id of the receiver' },
        fromAgent: { type: 'string', description: 'Defaults to Muse' },
        note: { type: 'string' },
      },
      required: ['title', 'toAgent'],
    },
  },
  {
    name: 'agentic_advance_handover',
    description: 'Move a handover one step: pending → sent → accepted → running → completed.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'handover id' } },
      required: ['id'],
    },
  },
  {
    name: 'agentic_chat',
    description: 'Talk to an agent through the Core. Muse answers from live state; other agents queue the message until their adapter is live.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Exact agent id' },
        message: { type: 'string' },
      },
      required: ['agentId', 'message'],
    },
  },
];

const TOOL_SCOPES = {
  agentic_get_state: ['state:read'],
  agentic_list_agents: ['state:read'],
  agentic_list_tasks: ['state:read'],
  agentic_emit_event: ['events:write'],
  agentic_create_handover: ['handovers:write'],
  agentic_advance_handover: ['handovers:write'],
  agentic_chat: ['chat:write'],
};

function callTool(name, args, auth) {
  const need = TOOL_SCOPES[name];
  if (need && !need.some((s) => hasScope(auth, s))) {
    return { content: [{ type: 'text', text: `Error: insufficient scope — this tool needs ${need.join(' or ')}.` }], isError: true };
  }
  switch (name) {
    case 'agentic_get_state':
      return { content: [{ type: 'text', text: JSON.stringify(getStateSnapshot(), null, 2) }] };
    case 'agentic_list_agents':
      return { content: [{ type: 'text', text: JSON.stringify(db.prepare('SELECT * FROM agents ORDER BY id').all(), null, 2) }] };
    case 'agentic_list_tasks': {
      const where = [];
      const params = [];
      if (args?.status) { where.push('status = ?'); params.push(args.status); }
      if (args?.owner) { where.push('owner = ?'); params.push(args.owner); }
      if (args?.projectId) { where.push('project_id = ?'); params.push(args.projectId); }
      const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`;
      return { content: [{ type: 'text', text: JSON.stringify(db.prepare(sql).all(...params), null, 2) }] };
    }
    case 'agentic_emit_event':
      return { content: [{ type: 'text', text: JSON.stringify(emitEvent(args ?? {}), null, 2) }] };
    case 'agentic_create_handover':
      return { content: [{ type: 'text', text: JSON.stringify(createHandover(args ?? {}), null, 2) }] };
    case 'agentic_advance_handover':
      return { content: [{ type: 'text', text: JSON.stringify(advanceHandover(Number(args?.id)), null, 2) }] };
    case 'agentic_chat':
      return { content: [{ type: 'text', text: JSON.stringify({ reply: chatReply(args?.agentId, args?.message) }, null, 2) }] };
    default:
      return { content: [{ type: 'text', text: `Error: unknown tool: ${name}` }], isError: true };
  }
}

const RESOURCES = [
  { uri: 'agentic://state', name: 'Agentic OS board state', mimeType: 'application/json' },
  { uri: 'agentic://agents', name: 'Agents', mimeType: 'application/json' },
  { uri: 'agentic://activity', name: 'Recent events (Activity River)', mimeType: 'application/json' },
];

function readResource(uri) {
  switch (uri) {
    case 'agentic://state':
      return JSON.stringify(getStateSnapshot(), null, 2);
    case 'agentic://agents':
      return JSON.stringify(db.prepare('SELECT * FROM agents ORDER BY id').all(), null, 2);
    case 'agentic://activity':
      return JSON.stringify(getStateSnapshot().events, null, 2);
    default:
      throw new Error(`unknown resource: ${uri}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatcher (shared by stdio + HTTP)
// ---------------------------------------------------------------------------

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export function handleMcpMessage(msg, ctx) {
  // Batch: dispatch each, return the non-null responses as an array.
  if (Array.isArray(msg)) {
    const out = msg.map((m) => handleMcpMessage(m, ctx)).filter(Boolean);
    return out.length ? out : null;
  }
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'invalid request: expected a JSON-RPC 2.0 object with a method');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const { method, params } = msg;

  // Notifications never get a response.
  if (isNotification) return null;

  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        const negotiated = PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST_PROTOCOL;
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: negotiated,
            capabilities: { tools: {}, resources: {} },
            serverInfo: SERVER_INFO,
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id: msg.id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
      case 'tools/call': {
        const result = callTool(params?.name, params?.arguments ?? {}, ctx.auth);
        return { jsonrpc: '2.0', id: msg.id, result };
      }
      case 'resources/list':
        return { jsonrpc: '2.0', id: msg.id, result: { resources: RESOURCES } };
      case 'resources/read': {
        const text = readResource(params?.uri);
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { contents: [{ uri: params.uri, mimeType: 'application/json', text }] },
        };
      }
      case 'resources/templates/list':
        return { jsonrpc: '2.0', id: msg.id, result: { resourceTemplates: [] } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id: msg.id, result: { prompts: [] } };
      default:
        return rpcError(msg.id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(msg.id, -32603, String(err?.message ?? err));
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP handler — mount in server.mjs (see design doc §6):
//   if (req.method === 'POST' && path === '/mcp')
//     return handleMcpHttp(req, res, { masterKey: API_KEY });
// GET /mcp is not supported (no server-initiated stream yet) → 405.
// ---------------------------------------------------------------------------

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
    req.on('error', reject);
  });
}

export async function handleMcpHttp(req, res, { masterKey }) {
  const send = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET') return send(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'GET /mcp not supported — use POST with a JSON-RPC 2.0 body' } });
  if (req.method !== 'POST') return send(405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'method not allowed' } });
  const auth = authenticateApiKey(db, req.headers['x-api-key'], masterKey);
  if (!auth) return send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'invalid or missing x-api-key' } });
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return send(400, rpcError(null, -32700, 'parse error: body is not valid JSON'));
  }
  const out = handleMcpMessage(body, { auth, transport: 'http' });
  if (out === null) return send(202, {});
  return send(200, out);
}

// ---------------------------------------------------------------------------
// stdio transport — `node src/mcp-server.mjs --stdio`
// ---------------------------------------------------------------------------

const isMain = process.argv[1]?.endsWith('mcp-server.mjs');
if (isMain && process.argv.includes('--stdio')) {
  seed();
  initApiKeys(db);
  // A client that closes the pipe early (e.g. piping to `head`) must not
  // crash us with an unhandled EPIPE — exit quietly instead.
  process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0);
    throw err;
  });
  const localAuth = { kind: 'local', scopes: [...SCOPES] };
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify(rpcError(null, -32700, 'parse error: line is not valid JSON')) + '\n');
      return;
    }
    const out = handleMcpMessage(msg, { auth: localAuth, transport: 'stdio' });
    if (out !== null) process.stdout.write(JSON.stringify(out) + '\n');
  });
}
