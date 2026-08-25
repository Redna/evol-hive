#!/bin/bash
# Restore YAAM memory from the memory branch and merge deltas.
set -e

echo "=== Restoring YAAM memory ==="

# 1. Check for local lock (Local Mode)
while [ -f "yaam-compaction.lock" ]; do
  echo "Local compaction in progress. Waiting 10s..."
  sleep 10
done

git fetch origin memory:refs/remotes/origin/memory 2>/dev/null || {
  echo "No memory branch yet — starting fresh."
  touch events.jsonl
  echo "0" > .yaam_start_lines
  exit 0
}

# 2. Check for remote lock (Distributed Mode)
if [ "$GITHUB_ACTIONS" == "true" ]; then
  while git ls-tree origin/memory | grep -q "yaam-compaction.lock" 2>/dev/null; do
    echo "Remote compaction in progress. Waiting 15s..."
    sleep 15
    git fetch origin memory:refs/remotes/origin/memory 2>/dev/null || true
  done
fi

# Extract all files instantly
git archive origin/memory 2>/dev/null | tar -x || true

if [ -f events.jsonl.gz ]; then
  gunzip events.jsonl.gz
fi

# Properly merge base and deltas in chronological order
if [ -f events.jsonl ]; then
  mv events.jsonl events-0000000000-base.jsonl
fi

# Concatenate all events-*.jsonl files (base comes first due to 000 prefix)
cat events-*.jsonl > events.jsonl 2>/dev/null || touch events.jsonl

# Clean up delta files from workspace
rm -f events-*.jsonl

LINES=$(wc -l < events.jsonl | cut -d' ' -f1)
SIZE=$(du -h events.jsonl | cut -f1)
echo "Restored and merged memory: $LINES events, $SIZE"

# Record how many lines we started with to compute the delta later!
echo "$LINES" > .yaam_start_lines