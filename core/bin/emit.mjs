#!/usr/bin/env node
// Emit CLI — how any agent feeds real events into the Agentic OS Core.
//
//   node bin/emit.mjs <agentId> <type> '<json-payload>'
//
// Examples:
//   node bin/emit.mjs claude heartbeat '{}'
//   node bin/emit.mjs claude task.started  '{"taskTitle":"P2 Core build","projectId":"agentic-os"}'
//   node bin/emit.mjs claude task.progress '{"taskTitle":"P2 Core build","progress":40}'
//   node bin/emit.mjs hermes task.done     '{"taskTitle":"Agent Hub health check"}'
//
// Env: AGENTIC_CORE_URL (default http://localhost:4310), AGENTIC_API_KEY (default dev-key).

const [agentId, type, payloadArg] = process.argv.slice(2);
if (!agentId || !type) {
  console.error('usage: node bin/emit.mjs <agentId> <type> \'<json-payload>\'');
  process.exit(2);
}
let payload = {};
try { payload = payloadArg ? JSON.parse(payloadArg) : {}; }
catch { console.error('payload is not valid JSON'); process.exit(2); }

const base = process.env.AGENTIC_CORE_URL ?? 'http://localhost:4310';
const res = await fetch(`${base}/api/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': process.env.AGENTIC_API_KEY ?? 'dev-key' },
  body: JSON.stringify({ agentId, type, ...payload }),
});
const out = await res.json().catch(() => ({}));
if (!res.ok) { console.error(`emit failed (${res.status}):`, out); process.exit(1); }
console.log(JSON.stringify(out, null, 2));
