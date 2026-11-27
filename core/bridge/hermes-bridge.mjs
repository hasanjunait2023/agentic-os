#!/usr/bin/env node
// Hermes Bridge — Agentic OS adapter for the Hermes Agent running on this VPS.
// Reads Hermes' own state files (data only, nothing executed) and reports to the
// Agentic OS Core: a heartbeat every run + an event when the gateway state changes.
// Run by cron every 2 minutes on the VPS. No dependencies beyond Node itself.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';

const CORE = 'http://127.0.0.1:4310';
const HERMES_HOME = '/home/hermes/.hermes';
const STATE_FILE = '/opt/agentic-os/bridge/last-state.json';

function envKey() {
  try {
    const m = readFileSync('/opt/agentic-os/.env', 'utf8').match(/AGENTIC_API_KEY=(\S+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}

function post(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(CORE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': envKey(), 'content-length': Buffer.byteLength(data) },
      timeout: 5000,
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end(data);
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let gw = {};
try { gw = JSON.parse(readFileSync(`${HERMES_HOME}/gateway_state.json`, 'utf8')); } catch {}
let gwPid = 0;
try { gwPid = JSON.parse(readFileSync(`${HERMES_HOME}/gateway.pid`, 'utf8')).pid ?? 0; } catch {}

const platforms = gw.platforms ?? {};
const platSummary = Object.entries(platforms).map(([k, v]) => `${k}:${v.state}`).join(', ');
const gatewayUp = gw.gateway_state === 'running' && alive(gwPid);

let tickerAgeMin = null;
try {
  const t = Number(readFileSync(`${HERMES_HOME}/cron/ticker_last_success`, 'utf8').trim());
  tickerAgeMin = Math.round((Date.now() / 1000 - (t > 1e12 ? t / 1000 : t)) / 60);
} catch {}

const signature = `${gw.gateway_state}|${gatewayUp}|${platSummary}`;
let last = {};
try { last = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}

const note = gatewayUp
  ? `Gateway running (pid ${gwPid}) · ${platSummary}${tickerAgeMin !== null ? ` · cron ticker ${tickerAgeMin}m ago` : ''}`
  : `Gateway DOWN (state: ${gw.gateway_state ?? 'unknown'}) · ${platSummary}`;

await post('/api/events', { agentId: 'hermes', type: 'heartbeat', note });

if (last.signature && last.signature !== signature) {
  if (gatewayUp) {
    await post('/api/events', { agentId: 'hermes', type: 'task.started', taskTitle: 'Hermes gateway', note: `Recovered — ${note}` });
  } else {
    await post('/api/events', { agentId: 'hermes', type: 'task.blocked', taskTitle: 'Hermes gateway', note });
  }
}
writeFileSync(STATE_FILE, JSON.stringify({ signature, at: new Date().toISOString() }));
console.log(`hermes-bridge: ${note}`);
