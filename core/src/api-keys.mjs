// Agentic OS Core — API key management (MCP / API Connection Design, Phase 1)
//
// Per-key API keys let Jafrul create, scope, and revoke credentials from the
// Connect page — no more sharing the single master key from .env with every
// integration, and no key is ever stored or shown in plaintext except once,
// at creation.
//
// Key format:  agk_live_<base64url(24 random bytes)>
// Storage:     only SHA-256(key) + the first 12 chars (prefix) are stored.
// Auth:        master key (env AGENTIC_API_KEY) = all scopes.
//              per-key keys = only their granted scopes.
// Scopes:      state:read, events:write, handovers:write, chat:write, keys:manage
//
// Wiring (see docs/MCP-API-CONNECTION-DESIGN.md §6):
//   - call initApiKeys(db) once at Core startup (from db.mjs seed() or server.mjs)
//   - mount the /api/keys routes in server.mjs (master key only)
//   - replace the `x-api-key !== API_KEY` checks with authenticateApiKey()

import { randomBytes, createHash } from 'node:crypto';
import { now } from './db.mjs';

export const KEY_PREFIX = 'agk_live_';
export const SCOPES = ['state:read', 'events:write', 'handovers:write', 'chat:write', 'keys:manage'];

// Create the api_keys table if it does not exist yet.
// Same SQLite <-> PostgreSQL naming rule as db.mjs: replay this DDL with
// AUTOINCREMENT -> SERIAL when the P5 Postgres migration happens.
export function initApiKeys(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      key_prefix   TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      scopes       TEXT NOT NULL,              -- JSON array of scope strings
      agent_id     TEXT,                       -- optional: key bound to one agent
      created_at   TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at   TEXT
    );
  `);
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function assertScopes(scopes) {
  const bad = (scopes ?? []).filter((s) => !SCOPES.includes(s));
  if (bad.length) throw new Error(`unknown scope(s): ${bad.join(', ')} (allowed: ${SCOPES.join(', ')})`);
}

// Create a key. Returns the plaintext key EXACTLY ONCE — the caller (Connect
// page / /api/keys) must show it to the owner and never store or log it.
export function createApiKey(db, { name, scopes = ['state:read', 'events:write'], agentId = null }) {
  if (!name || typeof name !== 'string') throw new Error('name is required');
  assertScopes(scopes);
  const raw = KEY_PREFIX + randomBytes(24).toString('base64url');
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO api_keys (name, key_prefix, key_hash, scopes, agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(name, raw.slice(0, 12), sha256(raw), JSON.stringify(scopes), agentId, ts);
  return {
    id: Number(info.lastInsertRowid),
    name,
    key: raw,
    keyPrefix: raw.slice(0, 12),
    scopes,
    agentId,
    createdAt: ts,
  };
}

// List keys for the Connect page. Never returns a hash or a plaintext key.
export function listApiKeys(db) {
  return db
    .prepare(
      `SELECT id, name, key_prefix, scopes, agent_id, created_at, last_used_at, revoked_at
       FROM api_keys ORDER BY id`,
    )
    .all()
    .map((r) => ({ ...r, scopes: JSON.parse(r.scopes), revoked: r.revoked_at !== null }));
}

export function revokeApiKey(db, id) {
  const info = db
    .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(now(), id);
  return info.changes > 0;
}

// Verify a presented key. Returns the grant ({ keyId, name, agentId, scopes })
// or null. Updates last_used_at on every successful check (audit trail).
export function verifyApiKey(db, key) {
  if (typeof key !== 'string' || !key.startsWith(KEY_PREFIX)) return null;
  const row = db
    .prepare(`SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`)
    .get(sha256(key));
  if (!row) return null;
  db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`).run(now(), row.id);
  return { keyId: row.id, name: row.name, agentId: row.agent_id, scopes: JSON.parse(row.scopes) };
}

// Authenticate one request. Returns { kind: 'master', scopes } for the env
// master key (works exactly as today), { kind: 'key', ...grant } for a
// per-key key, or null when the presented key is missing/invalid/revoked.
export function authenticateApiKey(db, presentedKey, masterKey) {
  if (typeof presentedKey === 'string' && presentedKey && presentedKey === masterKey) {
    return { kind: 'master', scopes: [...SCOPES] };
  }
  const grant = presentedKey ? verifyApiKey(db, presentedKey) : null;
  if (!grant) return null;
  return { kind: 'key', ...grant };
}

export function hasScope(auth, scope) {
  return !!auth && Array.isArray(auth.scopes) && auth.scopes.includes(scope);
}
