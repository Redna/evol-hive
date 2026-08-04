#!/bin/bash
# Bootstrap script for agent workflows on GitHub-hosted runners.
# Installs Pi, pi-goal, project deps, and configures Ollama Cloud.
set -e

# Install Pi
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Install pi-goal extension
pi install npm:@narumitw/pi-goal

# Configure Ollama Cloud as the LLM provider (direct API, no local daemon)
# Model names use NO :cloud suffix when calling ollama.com directly
mkdir -p ~/.pi/agent
cat scripts/ci-models.json | python3 -c "
import sys, json, os
d = json.load(sys.stdin)
d['providers']['ollama']['apiKey'] = os.environ.get('OLLAMA_API_KEY', 'missing')
json.dump(d, open(os.path.expanduser('~/.pi/agent/models.json'), 'w'), indent=2)
"

# Install project dependencies
pnpm install --frozen-lockfile

# Configure git for agent commits
git config user.name "evol-hive-agent[bot]"
git config user.email "agent-bot@evol-hive.local"

echo "Bootstrap complete: Pi + pi-goal + Ollama Cloud configured"