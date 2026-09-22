#!/bin/bash
# Bootstrap script for agent workflows on GitHub-hosted runners.
# Installs Pi, pi-goal, and configures Ollama Cloud.
set -e

echo "=== Installing Pi ==="
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

echo "=== Installing pi-goal ==="
if [ "$DISABLE_PI_EXTENSIONS" != "true" ]; then
  pi install npm:@narumitw/pi-goal
fi

# Configure Ollama Cloud as the LLM provider
echo "=== Configuring Ollama Cloud ==="
mkdir -p ~/.pi/agent
cat scripts/ci-models.json | python3 -c "
import sys, json, os
d = json.load(sys.stdin)
d['providers']['ollama']['apiKey'] = os.environ.get('OLLAMA_API_KEY', 'missing')
json.dump(d, open(os.path.expanduser('~/.pi/agent/models.json'), 'w'), indent=2)
"

# Raise the HTTP idle timeout — developer runs send large first prompts (full spec)
# and cloud models can take >2min to first token under load. Default is 300s but
# the runner environment has been canceling at exactly 120s; make it explicit.
python3 -c "
import json, os
p = os.path.expanduser('~/.pi/agent/settings.json')
try:
    s = json.load(open(p))
except Exception:
    s = {}
s['httpIdleTimeoutMs'] = 600000
json.dump(s, open(p, 'w'), indent=2)
"

# Add swap: hosted runners sit at ~93% memory (15.2/16GB) with the agent
# stack loaded (pi + pnpm). Any spike then OOM-kills the job —
# "The runner has received a shutdown signal" at scattered 4-13 min marks.
# 4GB of swap absorbs spikes so the runner survives.
if [ -z "${SKIP_SWAP:-}" ] && ! swapon --show | grep -q .; then
  echo "=== Adding 4GB swap ==="
  sudo fallocate -l 4G /swapfile \
    && sudo chmod 600 /swapfile \
    && sudo mkswap /swapfile > /dev/null \
    && sudo swapon /swapfile \
    && echo "Swap active: $(swapon --show | tail -1)" \
    || echo "⚠️ Swap setup failed — continuing without"
fi

# Install project dependencies
echo "=== Installing project deps ==="
pnpm install --frozen-lockfile

# Configure git for agent commits
git config user.name "evol-hive-agent[bot]"
git config user.email "agent-bot@evol-hive.local"

echo "=== Bootstrap complete: Pi + pi-goal + Ollama Cloud ==="