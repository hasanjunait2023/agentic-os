# Jafrul Agentic OS — Master Plan
**Owner:** Jafrul · **Lead / Orchestrator:** Muse (this chat = dedicated Agentic OS chat)
**Timezone:** Asia/Dhaka (UTC+6) · **UI language:** English · **Chat language:** Bengali
**Created:** 2026-11-27

## 1. Vision — এক লাইনে
একটাই Command Center যেখান থেকে Jafrul real-time দেখতে পাবেন: কোন agent, কোন chat-এ, কোন project-এ, ঠিক এখন কী কাজ করছে — কতটুকু শেষ, কী pending, কী blocked — এবং সেখান থেকেই এক click-এ কাজ অন্য agent-কে handover করতে পারবেন। সঙ্গে যুক্ত থাকবে তার Obsidian Second Brain।

এটা কোনো static dashboard না। এটা একটা **Agentic Operating System**:
- **Observe** — সব agent/project/chat-এর live অবস্থা
- **Understand** — plan vs progress, dependency, blocker
- **Control** — instruction দেওয়া, handover, pause/resume, approve
- **Remember** — Obsidian + Muse memory = একটাই Second Brain layer

## 2. Core Concepts (Domain Model)

| Entity | কী | Key fields |
|---|---|---|
| **Agent** | Muse, Claude Code, Hermes, OpenAI Dot Agent, + future agents | id, name, type, status (idle/running/paused/blocked/error/offline), current_task_id, capabilities, last_heartbeat, adapter_type |
| **Project** | Solixoo, IIP Reels, Agentic OS, future… | id, name, status, progress %, plan_id, repo, owner_agent, health, deadline |
| **Plan** | Project-এর total plan | phases[] → tasks[], milestones, dependencies |
| **Task / Run** | একটা নির্দিষ্ট কাজের execution | id, title, project_id, agent_id, chat_id, status, progress, started_at, eta, logs, artifacts |
| **Chat / Session** | কোন chat-এ কাজ হচ্ছে | id, platform (Muse/WhatsApp/Claude Code…), agent_id, project_id, last_activity |
| **Event** | Realtime-এ যা ঘটে | type (task.started, task.progress, task.done, agent.heartbeat, handover…), payload, ts |
| **Handover** | এক agent থেকে আরেক agent-কে কাজ transfer | from_agent, to_agent, task_id, context_bundle (plan + progress + files + decisions), status, ack |
| **Knowledge Node** | Obsidian note / memory | vault_path, title, links[], tags, project_id, updated_at |

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  UI — Agentic OS Dashboard (Next-level, motion + 3D)     │
│  Mission Control · Agent Orbit (3D) · Project Board     │
│  Live Activity River · Plan Timeline · Handover Center  │
│  Second Brain (Obsidian Graph) · Command Palette (⌘K)   │
└──────────────────────▲──────────────────────────────────┘
                       │ WebSocket (live) + REST (history)
┌──────────────────────┴──────────────────────────────────┐
│  CORE — Event Bus + State Store                          │
│  • Event Store (append-only, সব ঘটনার হিস্ট্রি)          │
│  • Live State (Redis/pub-sub → WebSocket fan-out)        │
│  • Plan Engine (phase/task tree, progress roll-up)       │
│  • Handover Engine (context bundle তৈরি + ack tracking)  │
│  • API: /agents /projects /tasks /events /handovers      │
└──────▲────────▲────────▲────────▲────────▲───────────────┘
       │        │        │        │        │
   ┌───┴──┐ ┌───┴──┐ ┌───┴───┐ ┌──┴───┐ ┌──┴──────┐
   │ Muse │ │Claude│ │Hermes │ │ Dot  │ │Obsidian │
   │Adapter│ │ Code │ │Adapter│ │Agent │ │ Vault   │
   │      │ │Adapter│ │      │ │Adapter│ │ Sync    │
   └──────┘ └──────┘ └───────┘ └──────┘ └─────────┘
     Muse      CLI /     API /     API /     File watcher
   chats +     logs /    webhook   webhook   (.md, frontmatter,
   subagents   MCP                              backlinks)
```

**Tech stack (প্রস্তাবিত, Phase 2-তে final):**
- Frontend: Next.js + TypeScript, Tailwind, Framer Motion (motion), Three.js / React Three Fiber (Agent Orbit 3D graph), Recharts
- Realtime: WebSocket (Socket.IO / native WS) — fallback SSE + polling
- Backend: Node (Next.js API / separate service), PostgreSQL (state + event store), Redis (pub/sub, presence/heartbeat)
- Adapters: প্রতিটা agent-এর জন্য ছোট connector — heartbeat + event পাঠায় core-এ, instruction নেয় core থেকে
- Deploy: Jafrul-এর VPS (72.62.228.196, Coolify/Docker pattern Solixoo-র মতোই) — পরে subdomain যেমন `os.ecomex.cloud`

## 4. Agent Adapters — কীভাবে প্রতিটা agent যুক্ত হবে

| Agent | সংযোগের উপায় | Phase |
|---|---|---|
| **Muse (আমি)** | Native — আমার chats, subagents, goals, tracked items সরাসরি event হিসেবে পাঠানো যাবে। এই chat-ই হবে Orchestrator। | P1–P2 |
| **Claude Code** | CLI wrapper / log watcher + MCP server — session, file change, test result, commit event | P3 |
| **Hermes Agent** | তার API/webhook থাকলে সরাসরি; না থাকলে file/log bridge + manual status ping adapter | P3 |
| **OpenAI Dot Agent** | API/webhook bridge; না থাকলে একই generic adapter protocol | P3 |
| **Future agents** | **Generic Adapter Protocol** — যেকোনো agent শুধু ৪টা event পাঠালেই যুক্ত: `heartbeat`, `task.started`, `task.progress`, `task.done/blocked` (REST POST + API key) | P2 |

> মূল নীতি: কোনো agent-এর ভেতরে ঢুকতে না পারলেও তাকে বাদ দেওয়া হবে না — adapter স্তরে যতটা পাওয়া যায় সেই ক্রমে যুক্ত করা হবে, আর UI-তে পরিষ্কার দেখানো হবে কোনটা live, কোনটা partial।

### 4.1 সব Connection Option-ই রাখা হবে (Jafrul-এর নির্দেশ, 2026-11-27 15:37 +06)
Jafrul বলেছেন: **সবগুলো option-ই রাখতে হবে, যাতে যেই option-ই থাকুক না কেন তিনি সহজে connect করতে পারেন।** তাই প্রতিটা agent-এর জন্য Connect 화면ে সব পদ্ধতিই থাকবে, fallback chain সহ:

1. **REST API + API key** — agent event পাঠাবে / instruction নেবে
2. **MCP server** — যেমন তার নিজের n8n MCP (https://n8n.ecomex.cloud/mcp-server/http, connected) — tool-call ভিত্তিক সংযোগ
3. **CLI / command-line bridge** — Claude Code-এর মতো CLI agent-দের জন্য wrapper (CLI-Anything মূল্যায়ন চলছে, নিচে §4.2)
4. **Webhook** — incoming (agent → OS) + outgoing (OS → agent)
5. **WebSocket live stream** — সবচেয়ে realtime সংযোগ
6. **Log file watcher** — agent-এর log/session ফাইল পড়ে status বের করা
7. **File / folder bridge** — shared folder / markdown ফাইল দিয়ে আদান-প্রদান (Obsidian পদ্ধতির মতোই)
8. **SSH** — VPS/server-এ চলা agent বা service-এর জন্য
9. **Browser / web session** — শুধু web UI আছে এমন agent-এর জন্য
10. **n8n workflow bridge** — Jafrul-এর Agent Hub workflow (Job Queue / MCP) দিয়ে routing
11. **Manual / copy-paste instruction** — সবসময় কাজ করে এমন শেষ fallback: OS bundle তৈরি করবে, Jafrul paste করবেন, ফলাফল paste back

নিয়ম: একটা পদ্ধতি না থাকলে agent আটকাবে না — OS ক্রমানুসারে পরের পদ্ধতিতে fallback করবে এবং UI-তে দেখাবে কোন পদ্ধতিতে connected, কোনটা partial/manual।

### 4.2 CLI-Anything (HKUDS) — যাচাই শেষ, VERDICT: সরাসরি কাজে লাগবে ✅
- Repo: https://github.com/HKUDS/CLI-Anything (HEAD 34f5195) — clone: ~/workspace/tools/CLI-Anything
- **কী এটা:** যেকোনো software-কে agent-native CLI-তে রূপ দেওয়ার framework + তৈরি harness-এর registry (CLI-Hub)। প্রতিটা harness JSON output দেয় + SKILL.md সহ আসে।
- **Install যাচাই (2026-11-27):** isolated venv-তে `pip install cli-anything-hub` → `cli-hub 0.4.1` চলছে, registry-তে 176 লাইন CLI তালিকা; search যাচাই: obsidian, obsidian-cli, obsidian-agent-cli, n8n (55+ commands) পাওয়া গেছে। Venv: ~/workspace/tools/cli-anything-venv
- **Agentic OS-এ সরাসরি ব্যবহার:**
  1. **Obsidian harness** (`cli-anything-obsidian`, Local REST API ভিত্তিক, vault list/search/notes) → Phase 4 Second Brain sync-এর তৈরি রাস্তা — নিজে বানাতে হবে না।
  2. **n8n harness** (REST API, 55+ commands) → Jafrul-এর n8n Agent Hub-এর CLI bridge হিসেবে MCP-এর পাশাপাশি আরেকটা connection option।
  3. **Hermes skill** (repo-তে `hermes-skill/` প্রস্তাবিত) → Hermes adapter-এর সূত্রপাত।
  4. **Generic pattern:** যেই software/agent-এর API নেই, তার জন্য CLI-Anything পদ্ধতিতে harness বানানোই হবে OS-এর CLI bridge কৌশল।
- **ভবিষ্যৎ কাজেও লাগবে:** Blender, Browser, ComfyUI, LibreOffice, Draw.io, Kdenlive ইত্যাদি harness — IIP reel/video ও document কাজে agent দিয়ে software চালানোর রাস্তা।
- সতর্কতা: harness install মানে তৃতীয় পক্ষের code চালানো — প্রতিটা harness ব্যবহারের আগে আলাদা করে যাচাই করে তবেই চালু করা হবে।

## 5. Handover System — সবচেয়ে গুরুত্বপূর্ণ ফিচার

Jafrul বলবেন (বা UI থেকে click): *"এই কাজটা Hermes-কে handover করো"*

1. Muse context bundle তৈরি করবে: task-এর লক্ষ্য, plan, এখন পর্যন্ত progress, সিদ্ধান্তসমূহ, relevant files/links, blocker
2. Bundle → target agent-এর adapter দিয়ে পাঠানো হবে
3. Target agent `ack` দিলে UI-তে status: Pending → Sent → Accepted → Running
4. পুরোনো agent ওই task-এ থেমে যাবে (duplicate কাজ হবে না — Solixoo-তে দুই chat-এর coordination সমস্যার শিক্ষা থেকেই এই নিয়ম)
5. পুরো handover history Event River-এ থাকবে

## 6. Obsidian Second Brain Integration

- Vault = folder of `.md` — file watcher দিয়ে sync (পরিবর্তন হলেই event)
- Frontmatter দিয়ে note ↔ project/agent/task link (`project: solixoo` ইত্যাদি)
- UI-তে: Knowledge Graph (3D/2D), project অনুযায়ী notes, সাম্প্রতিক পরিবর্তন
- Muse-এর memory (`MEMORY.md`, goals) আর Obsidian — দুটোই একই Knowledge layer-এ দেখা যাবে, source আলাদা করে চিহ্নিত
- Jafrul vault-এর path/access দিলেই Phase 4-এ live sync চালু হবে

## 7. UI/UX Design Direction

- **Feel:** Mission Control / Linear + Raycast + sci-fi OS — dark theme primary, glass, soft-3D depth, smooth motion সর্বত্র
- **Home = Mission Control:** উপরে live stats (active agents, running tasks, projects health), মাঝে Agent Orbit (3D-তে agent-রা node, চলমান কাজ pulse করছে), নিচে Live Activity River
- **Views:** Overview · Agents · Projects (kanban + progress) · Plans (timeline/Gantt) · Activity · Handovers · Second Brain · Command Center
- **Command Palette (⌘K):** যেকোনো জায়গা থেকে instruction — "handover X to Hermes", "pause Solixoo redesign" টাইপ natural command
- **Motion:** page transition, live pulse, progress animation, 3D orbit — কিন্তু performance-first, motion কখনো তথ্যের বদলি না
- ** বর্তমান prototype-এ seed হিসেবে থাকছে আসল inventory:** Solixoo, IIP (Impact Investment PLC), Agentic OS; agents: Muse, Claude Code, Hermes, Dot Agent

## 8. Phases / Roadmap

| Phase | কী | Status |
|---|---|---|
| **P0 — Plan** | এই master plan + UI prototype | ✅ চলছে (আজ) |
| **P1 — Prototype UI** | Fullstack dashboard: agents/projects/tasks/handovers CRUD + simulated realtime feed দিয়ে পুরো experience যাচাই | 🔄 আজই build শুরু |
| **P2 — Real Core** | আসল backend: event store, WebSocket server, Generic Adapter Protocol, Muse-এর আসল data (goals/chats/projects) live feed | ⏭️ Next |
| **P2.5 — MCP + API keys** | MCP server (stdio + POST /mcp) + Connect page থেকে API key বানানো/revoke + live Connect matrix | 🔄 Design + wire-in চলছে (2026-11-27) |
| **P3 — External Adapters** | Claude Code, Hermes, Dot Agent — একে একে live adapter | ⏭️ |
| **P4 — Obsidian Sync** | Jafrul vault দিলে live sync + knowledge graph | ⏭️ vault access পেলে |
| **P5 — Deploy + Control** | VPS-এ deploy (`os.ecomex.cloud`), সেখান থেকে সত্যিকারের handover/instruction execution | ⏭️ |

## 9. Jafrul-এর কাছ থেকে যা লাগবে (শুধু owner-only)
1. Obsidian vault-এর অবস্থান/access (P4-এর সময়)
2. Hermes ও Dot Agent তিনি কীভাবে চালান (app/API/CLI — কোনটা) — P3-এর সময়, adapter বানাতে
3. Deploy subdomain পছন্দ (প্রস্তাব: `os.ecomex.cloud`)

বাকি সব — design, architecture, build, test — এই chat থেকে আমি developer হিসেবে চালিয়ে যাব, phase শেষ হলেই পরের phase শুরু হবে, মাঝে জিজ্ঞেস করে থামব না।
