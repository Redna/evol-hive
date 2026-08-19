#!/bin/bash
# Compaction job: squashes all jsonl files into a single events.jsonl
set -e

echo "=== Starting Compaction ==="

# Check if YAAM daemon is running locally
if pgrep yaam-engine > /dev/null; then
  echo "YAAM engine is currently running."
  echo "Please pause agents before running local compaction to prevent memory loss."
  exit 1
fi

# Acquire Lock locally
touch yaam-compaction.lock

WORKTREE="/tmp/yaam-compaction-worktree"
rm -rf "$WORKTREE"

if [ "$GITHUB_ACTIONS" == "true" ]; then
  git worktree add "$WORKTREE" memory 2>/dev/null || {
    echo "Memory branch doesn't exist yet."
    rm yaam-compaction.lock
    exit 0
  }
  
  cd "$WORKTREE"
  cp ../yaam-compaction.lock .
  git add yaam-compaction.lock
  git commit -m "Acquire compaction lock"
  git push origin memory || {
    echo "Failed to acquire remote lock. Exiting."
    cd - >/dev/null
    rm -rf "$WORKTREE" yaam-compaction.lock
    exit 1
  }
  cd - >/dev/null
fi

# Merge current files
if [ "$GITHUB_ACTIONS" == "true" ]; then
  cat "$WORKTREE"/*.jsonl > events.jsonl 2>/dev/null || true
else
  cat *.jsonl > events.jsonl 2>/dev/null || true
fi

# Run compactor
node scripts/compact.js events.jsonl events-compacted.jsonl

mv events-compacted.jsonl events.jsonl

if [ "$GITHUB_ACTIONS" == "true" ]; then
  cd "$WORKTREE"
  # Clean up old tracking files
  git rm -f *.jsonl 2>/dev/null || true
  # Add the new compacted file
  cp ../events.jsonl .
  git add events.jsonl
  # Release lock
  git rm -f yaam-compaction.lock 2>/dev/null || true
  git commit -m "Release compaction lock and push compacted memory"
  git push origin memory
  cd - >/dev/null
  git worktree remove "$WORKTREE" --force
fi

rm -f yaam-compaction.lock
echo "=== Compaction Complete ==="
