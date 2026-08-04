#!/bin/bash
# Restore YAAM memory from the memory branch
# Usage: bash scripts/restore-memory.sh
set -e

echo "=== Restoring YAAM memory ==="

# Fetch the memory branch (may not exist on first run)
git fetch origin memory:memory 2>/dev/null || {
  echo "No memory branch yet — starting fresh."
  touch events.jsonl
  exit 0
}

# Extract events.jsonl from the memory branch
if git show memory:events.jsonl > events.jsonl 2>/dev/null; then
  LINES=$(wc -l < events.jsonl)
  SIZE=$(du -h events.jsonl | cut -f1)
  echo "Restored events.jsonl: $LINES events, $SIZE"
else
  echo "No events.jsonl on memory branch — starting fresh."
  touch events.jsonl
fi