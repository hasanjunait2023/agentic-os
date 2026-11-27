#!/usr/bin/env python3
"""Build a knowledge graph from the Second Brain vault's markdown notes.
Data-only: reads note text, extracts [[wikilinks]] and #tags. Nothing from
the vault is executed or imported. Output: stats + a reduced web graph."""
import json, os, re, sys
from collections import Counter, defaultdict

VAULT = os.path.expanduser("~/workspace/second-brain-vault")
OUT = os.path.expanduser("~/workspace/projects/agentic-os/brain")
os.makedirs(OUT, exist_ok=True)

WIKI = re.compile(r"\[\[([^\]\|#]+)")
TAG = re.compile(r"(?<!\w)#([A-Za-z0-9_\-/]+)")

notes = {}          # key (lower basename) -> {title, path, folder}
files = []
for root, dirs, names in os.walk(VAULT):
    dirs[:] = [d for d in dirs if d != ".git"]
    for n in names:
        if n.endswith(".md"):
            files.append(os.path.join(root, n))

for f in files:
    rel = os.path.relpath(f, VAULT)
    base = os.path.splitext(os.path.basename(f))[0]
    folder = rel.split(os.sep)[0] if os.sep in rel else "(root)"
    notes.setdefault(base.lower(), {"title": base, "path": rel, "folder": folder})

edges = set()
tags = Counter()
degree = Counter()
for f in files:
    rel = os.path.relpath(f, VAULT)
    src = os.path.splitext(os.path.basename(f))[0]
    try:
        text = open(f, encoding="utf-8", errors="ignore").read()
    except Exception:
        continue
    for t in TAG.findall(text):
        tags[t] += 1
    for m in WIKI.findall(text):
        tgt = m.strip()
        if not tgt or tgt.lower() == src.lower():
            continue
        if tgt.lower() in notes:
            a, b = src, notes[tgt.lower()]["title"]
            edges.add((min(a, b, key=str.lower), max(a, b, key=str.lower)))
            degree[a] += 1
            degree[b] += 1

folders = Counter(v["folder"] for v in notes.values())
hubs = [{"title": t, "degree": d, "folder": notes[t.lower()]["folder"]}
        for t, d in degree.most_common(30)]
orphans = sum(1 for k in notes if degree[notes[k]["title"]] == 0)

stats = {
    "notes": len(files), "nodes": len(notes), "edges": len(edges),
    "folders": dict(folders.most_common()), "orphans": orphans,
    "top_tags": dict(tags.most_common(15)), "hubs": hubs,
}
json.dump(stats, open(os.path.join(OUT, "stats.json"), "w"), indent=1, ensure_ascii=False)

# reduced web graph: top nodes by degree, edges among them
top = [h["title"] for h in hubs[:40]]
keep = set(top)
# add neighbours of top hubs until ~240 nodes
for a, b in edges:
    if a in keep or b in keep:
        keep.add(a); keep.add(b)
    if len(keep) >= 240:
        break
web_nodes = [{"id": t, "d": degree[t], "f": notes[t.lower()]["folder"]}
             for t in sorted(keep, key=lambda x: -degree[x])]
web_edges = [[a, b] for a, b in edges if a in keep and b in keep]
json.dump({"nodes": web_nodes, "edges": web_edges, "stats": {
    "notes": stats["notes"], "edges": stats["edges"], "shown": len(web_nodes)}},
    open(os.path.join(OUT, "web-graph.json"), "w"), ensure_ascii=False)
print(json.dumps({"notes": stats["notes"], "nodes": stats["nodes"],
                  "edges": stats["edges"], "orphans": orphans,
                  "web_nodes": len(web_nodes), "web_edges": len(web_edges)}, indent=1))
print("folders:", dict(folders.most_common(8)))
print("top hubs:", [(h["title"], h["degree"]) for h in hubs[:12]])
