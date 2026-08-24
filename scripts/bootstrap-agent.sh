#!/bin/bash
# Bootstrap script for agent workflows on GitHub-hosted runners.
# Installs Pi, pi-goal, YAAM (with daemon + model), and configures Ollama Cloud.
set -e

export YAAM_DISABLE_AUTO_COMPACT="true"

echo "=== Installing Pi ==="
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

echo "=== Installing pi-goal ==="
pi install npm:@narumitw/pi-goal

echo "=== Installing YAAM extension ==="
pi install https://github.com/Redna/yaam

YAAM_DIR="$HOME/.pi/agent/git/github.com/Redna/yaam"
BINARY_PATH="$YAAM_DIR/src-rust/target/release/yaam-engine"
CACHED_BINARY="$HOME/.yaam-cache/yaam-engine"

# Build or restore YAAM daemon binary
if [ -f "$CACHED_BINARY" ]; then
  echo "=== Restoring YAAM binary from cache ==="
  mkdir -p "$(dirname "$BINARY_PATH")"
  cp "$CACHED_BINARY" "$BINARY_PATH"
  chmod +x "$BINARY_PATH"
else
  echo "=== Building YAAM binary from source ==="
  # Install Rust toolchain
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source "$HOME/.cargo/env"
  # Build the daemon
  cd "$YAAM_DIR/src-rust"
  cargo build --release 2>&1 | tail -5
  # Cache the binary for future runs
  mkdir -p "$HOME/.yaam-cache"
  cp "$BINARY_PATH" "$CACHED_BINARY"
  cd -
fi

# Download or restore ONNX model files
MODEL_DIR="$HOME/.yaam/models"
if [ -f "$MODEL_DIR/model.onnx" ] && [ -f "$MODEL_DIR/tokenizer.json" ]; then
  echo "=== ONNX model already present ==="
else
  echo "=== Downloading ONNX model (gte-small, ~134MB) ==="
  "$BINARY_PATH" setup
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

# Install project dependencies
echo "=== Installing project deps ==="
pnpm install --frozen-lockfile

# Configure git for agent commits
git config user.name "evol-hive-agent[bot]"
git config user.email "agent-bot@evol-hive.local"

echo "=== Bootstrap complete: Pi + pi-goal + YAAM + Ollama Cloud ==="