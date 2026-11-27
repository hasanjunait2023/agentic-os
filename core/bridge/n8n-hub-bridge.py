#!/usr/bin/env python3
"""Agentic OS ⇄ n8n Agent Hub bridge (ChatGPT side: dot + codex).

Reads the Agent Hub Jobs data table through the n8n MCP connector and mirrors
job activity for the OpenAI-family agents (dot, codex) into the Agentic OS Core:
- a heartbeat for `dot` every run (note carries queue counts for dot + codex)
- an event whenever a hub job changes state (queued -> claimed -> completed)

State is kept in bridge/hub-state.json so each change is reported exactly once.
The core API key is fetched from the VPS over SSH into process memory only —
never printed, never written to disk here.
"""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE_FILE = HERE / "hub-state.json"
CLIENT = Path.home() / "workspace/custom-connectors/custom.n8n/bin/client.py"
TABLE_ID = "wgVQAG3W8Iojvr40"   # "Agent Hub Jobs"
PROJECT_ID = "DiNSk8Brj14FRibU"
CORE = "https://os.ecomex.cloud"
AGENTS = ("dot", "codex")


def n8n_rows():
    args_file = HERE / ".rows-args.json"
    args_file.write_text(json.dumps({"dataTableId": TABLE_ID, "projectId": PROJECT_ID, "limit": 100}))
    out = subprocess.run(
        [sys.executable, str(CLIENT), "call-tool", "--name", "get_data_table_rows",
         "--arguments-file", str(args_file)],
        capture_output=True, text=True, timeout=90)
    args_file.unlink(missing_ok=True)
    if out.returncode != 0:
        raise RuntimeError(f"n8n read failed: {out.stderr[:200]}")
    payload = json.loads(json.loads(out.stdout)["content"][0]["text"])
    return payload.get("data") or payload.get("rows") or []


def core_key():
    out = subprocess.run(
        ["ssh", "-F", "/home/hatch/.ssh/config", "-o", "BatchMode=yes", "jafrul-vps",
         "grep '^AGENTIC_API_KEY=' /opt/agentic-os/.env | cut -d= -f2-"],
        capture_output=True, text=True, timeout=30)
    key = out.stdout.strip()
    if not key:
        raise RuntimeError("could not read core key from VPS")
    return key


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post_event(key, body):
    req = urllib.request.Request(
        CORE + "/api/events", data=json.dumps(body).encode(), method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("x-api-key", key)
    req.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36")
    with OPENER.open(req, timeout=20) as r:
        return r.status


def main():
    rows = [r for r in n8n_rows() if r.get("target") in AGENTS]
    key = core_key()
    state = {}
    if STATE_FILE.exists():
        state = json.loads(STATE_FILE.read_text())
    seen = state.get("jobs", {})

    counts = {}
    for a in AGENTS:
        mine = [r for r in rows if r["target"] == a]
        counts[a] = {
            "queued": sum(1 for r in mine if r["status"] == "queued"),
            "claimed": sum(1 for r in mine if r["status"] not in ("queued", "completed")),
            "completed": sum(1 for r in mine if r["status"] == "completed"),
        }

    note = " · ".join(
        f"{a}: {c['queued']} queued, {c['claimed']} in progress, {c['completed']} done"
        for a, c in counts.items())
    post_event(key, {"agentId": "dot", "type": "heartbeat",
                     "note": f"Agent Hub bridge live — {note}"})

    for r in sorted(rows, key=lambda x: int(x["id"])):
        jid, status = str(r["id"]), r["status"]
        prev = seen.get(jid)
        if prev == status:
            continue
        seen[jid] = status
        title = (r.get("task") or "Hub job")[:90]
        if status == "queued" and prev is None:
            post_event(key, {"agentId": r["target"], "type": "task.started",
                             "taskTitle": title,
                             "note": f"Queued in n8n Agent Hub (job #{jid}) — waiting for {r['target']} to claim"})
        elif status == "completed":
            post_event(key, {"agentId": r["target"], "type": "task.done",
                             "taskTitle": title,
                             "note": f"Completed via Agent Hub (job #{jid}) — result: {(r.get('result') or '')[:200]}"})
        elif prev is not None:
            post_event(key, {"agentId": r["target"], "type": "task.progress",
                             "taskTitle": title,
                             "note": f"Agent Hub job #{jid} → {status}"})

    STATE_FILE.write_text(json.dumps({"jobs": seen}, indent=1))
    print(f"hub-bridge ok — {note}")


if __name__ == "__main__":
    main()
