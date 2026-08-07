#!/bin/bash
# Restore YAAM memory from the memory branch using git show.
# No branch switching — just read the file content from the remote branch.
set -e

echo "=== Restoring YAAM memory ==="

# Fetch the memory branch ref
git fetch origin memory:refs/remotes/origin/memory 2>/dev/null || {
  echo "No memory branch yet — starting fresh."
  touch events.jsonl
  exit 0
}

# Extract events.jsonl from the memory branch without switching branches
if git show origin/memory:events.jsonl > events.jsonl 2>/dev/null; then
  LINES=$(wc -l < events.jsonl)
  SIZE=$(du -h events.jsonl | cut -f1)
  echo "Restored events.jsonl: $LINES events, $SIZE"
else
  echo "No events.jsonl on memory branch — starting fresh."
  touch events.jsonl
fi