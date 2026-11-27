#!/bin/bash
# Shared Brain sync — vault (GitHub, private) -> local .md copy -> Agentic OS graph.
# Data-only pipeline: transfers markdown text, never executes vault content.
# Route: VPS holds the GitHub key (direct clone from this VM is blocked for private repos).
set -e
VPS_SSH="ssh -F /home/hatch/.ssh/config -o BatchMode=yes jafrul-vps"
$VPS_SSH "cd /tmp/second-brain 2>/dev/null || git clone git@github.com:hasanjunait2023/second-brain.git /tmp/second-brain; cd /tmp/second-brain && git pull --ff-only -q && find . -name '*.md' -not -path './.git/*' | tar czf /tmp/vault-md.tgz -T -"
scp -F /home/hatch/.ssh/config -o BatchMode=yes jafrul-vps:/tmp/vault-md.tgz /tmp/vault-md.tgz
rm -rf ~/workspace/second-brain-vault && mkdir -p ~/workspace/second-brain-vault
tar xzf /tmp/vault-md.tgz -C ~/workspace/second-brain-vault
python3 ~/workspace/projects/agentic-os/tools/build_graph.py
echo "Brain synced: graph rebuilt at ~/workspace/projects/agentic-os/brain/"
