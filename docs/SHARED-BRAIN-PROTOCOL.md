# Shared Brain Protocol — সবার একটাই Second Brain
**Brain repo:** github.com/hasanjunait2023/second-brain (Obsidian vault, private)
**Owner:** Jafrul · **Rule set by Jafrul:** 2026-11-27 — "যেই agent-ই connected থাকবে, সবাই এটাকেই use করবে, এটাই সবার second brain হবে, আর এটা always updated থাকবে by every agent."

## 1. মূল নীতি
- এই vault-ই সব agent-এর **একমাত্র shared second brain**। কোনো agent নিজের আলাদা স্মৃতিকে সত্য বলে চালাবে না — দ্বন্দ্ব হলে vault জিতবে, agent তার local note ঠিক করবে।
- Brain-এ যা নেই, তা ঘটেনি (shared কাজের ক্ষেত্রে)। গুরুত্বপূর্ণ সিদ্ধান্ত, ফলাফল, শেখা জিনিস — কাজ শেষ হলেই brain-এ লিখতে হবে।
- Graph value = যা ঢোকানো হয়। অল্প করে, নিয়মিত ঢোকাও।

## 2. কে কীভাবে যুক্ত হবে (সব connection option-ই খোলা)
| Agent | পড়ার পথ | লেখার পথ |
|---|---|---|
| Muse (Orchestrator) | Local working copy `~/workspace/second-brain-vault` (শুধু .md) + Agentic OS graph | Sync pipeline দিয়ে note জমা → repo-তে push (VPS route) |
| Claude Code | Repo clone / Obsidian CLI (CLI-Anything harness) | নিজের folder-এ commit + push |
| Hermes Agent | Repo / n8n bridge / vault-এর existing `notes/agents/hermes` | `notes/from-agents/` + hermes folder-এ commit |
| OpenAI Dot Agent | GitHub web / API / manual bundle | Manual বা API দিয়ে note জমা |
| Obsidian (Jafrul নিজে) | Vault সরাসরি | যেভাবে এখন লেখেন — auto-snapshot commit চলমান |

## 3. পড়ার নিয়ম (সব agent)
1. প্রথমে `INDEX.md` — তারপর দরকারি ১–৩টা note-ই শুধু পড়ো। পুরো vault context-এ ঢোকানো নিষেধ (token waste + noise)।
2. "X আর Y কীভাবে connected" জাতীয় প্রশ্নে graph ব্যবহার করো: Agentic OS-এর Brain view (graphify) বা vault-এর `graphify-out/GRAPH_REPORT.md`।
3. কাজ শুরুর আগে সংশ্লিষ্ট project note-টা পড়ে নাও — অন্য agent কী করে গেছে জানা থাকবে, duplicate কাজ হবে না।

## 4. লেখার নিয়ম (সব agent) — এভাবেই brain always updated থাকে
1. **কাজ শেষ মানেই brain update:** প্রতিটা অর্থবহ কাজের শেষে হয় existing note update, নয় নতুন note।
2. **জায়গা:** নিজের agent folder — `notes/from-agents/<agent-name>/` (vault-এ এই ব্যবস্থা আগে থেকেই আছে: axis, jamal প্রভৃতি সেখানে লিখছে)। Project-এর জিনিস হলে `notes/projects/`-এর সংশ্লিষ্ট note-এও link দাও।
3. **Frontmatter বাধ্যতামূলক:**
   ```
   ---
   agent: claude-code        # কে লিখল
   project: solixoo          # কোন project
   updated: 2026-11-27       # Asia/Dhaka তারিখ
   source: <chat/session id বা সংক্ষিপ্ত সূত্র>
   ---
   ```
4. **Wikilink দাও:** নতুন note-কে অন্তত ২টা existing note-এর সঙ্গে `[[link]]` করো — link ছাড়া note graph-এ দ্বীপ হয়ে থাকে (বর্তমান vault-এ orphan মাত্র 14টা — এই মান ধরে রাখতে হবে)।
5. **অন্য agent-এর note overwrite করো না:** দ্বিমত থাকলে নিজের note-এ লিখে link করো, বা নিচে `## Update — <agent>, <date>` section যোগ করো।
6. **Commit নিয়ম:** `brain: <agent> <project> — <কী বদলাল>` format-এ commit + push। Push না হলে update হয়নি বলে ধরা হবে।

## 5. Sync ও Graph refresh (system)
- **Vault → Agentic OS:** `tools/sync_brain.sh` (এই repo-তে) — VPS দিয়ে সর্বশেষ snapshot আনে → শুধু .md extract করে → `tools/build_graph.py` graph rebuild করে (nodes/edges/stats) → Brain view-এর data আপডেট হয়। P2-তে এটা scheduled হয়ে যাবে (দিনে কয়েকবার + বড় update-এর পর)।
- **Graphify (Jafrul-এর existing system):** vault-এর নিজের graphify pipeline (`graphify-out/`) তার machine-এ চলতে থাকবে — Agentic OS-এর graph তারই web-রূপ: একই wikilink data, OS-এর ভেতরে দেখার জন্য।
- **সুরক্ষা:** vault-এর কোনো script/plugin agent-রা চালাবে না — brain হলো data (markdown), code না। পড়া হবে text হিসেবে, লেখা হবে markdown হিসেবে।

## 6. বর্তমান অবস্থা (2026-11-27 যাচাই)
- 1,256 notes · 2,851 wikilink edges · orphan মাত্র 14
- বড় hub: `hostinger-vps` (438 links), `INDEX` (197), `contabo-vps-stack` (181), `trading-knowledge-base` (166), `hermes-agents` (92)
- Folder: notes/ 1,157 · legacy/ 78 · বাকি root/raw/scripts
- Agentic OS Brain view এখন থেকে এই আসল graph-টাই দেখাবে ("awaiting vault access" placeholder শেষ)।
