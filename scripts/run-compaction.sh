#!/bin/bash
# Compaction job: squashes all jsonl files into a single events.jsonl
# Acquires a lock on the memory branch so that parallel agents wait
ORIG_DIR="$(pwd)"
# in restore-memory.sh and save-memory.sh before proceeding.
set -e

echo "=== Starting Compaction ==="

if [ "$GITHUB_ACTIONS" == "true" ]; then
  git config --global user.name "evol-hive-compactor[bot]"
  git config --global user.email "compactor-bot@evol-hive.local"
fi

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

# ── Cleanup function (always releases lock, even on failure) ────────────────
cleanup() {
  local exit_code=$?
  if [ "$GITHUB_ACTIONS" == "true" ] && [ -d "$WORKTREE" ]; then
    # Try to release the remote lock
    cd "$WORKTREE" 2>/dev/null && {
      git rm -f yaam-compaction.lock 2>/dev/null || true
      git commit -m "Release compaction lock (cleanup)" 2>/dev/null || true
      git push origin memory 2>/dev/null || true
    }
    cd - >/dev/null 2>/dev/null
    git worktree remove "$WORKTREE" --force 2>/dev/null || rm -rf "$WORKTREE"
  fi
  rm -f yaam-compaction.lock
  rm -f events-0000000000-base.jsonl events-*.jsonl 2>/dev/null || true
  exit $exit_code
}
trap cleanup EXIT

if [ "$GITHUB_ACTIONS" == "true" ]; then
  git worktree add "$WORKTREE" memory 2>/dev/null || {
    echo "Memory branch doesn't exist yet."
    rm yaam-compaction.lock
    exit 0
  }
  
  cd "$WORKTREE"
  cp "$ORIG_DIR/yaam-compaction.lock" .
  git add yaam-compaction.lock
  git commit -m "Acquire compaction lock"
  git push origin memory || {
    echo "Failed to acquire remote lock — another compaction may be running. Exiting."
    cd - >/dev/null
    exit 1
  }
  cd - >/dev/null
fi

# ── Merge all delta files into a single events.jsonl ────────────────────────
if [ "$GITHUB_ACTIONS" == "true" ]; then
  if [ -f "$WORKTREE/events.jsonl.gz" ]; then
    cp "$WORKTREE/events.jsonl.gz" "$WORKTREE/events-0000000000-base.jsonl.gz"
    gunzip -f "$WORKTREE/events-0000000000-base.jsonl.gz"
  elif [ -f "$WORKTREE/events.jsonl" ]; then
    mv "$WORKTREE/events.jsonl" "$WORKTREE/events-0000000000-base.jsonl"
  fi
  cat "$WORKTREE"/events-*.jsonl > events.jsonl 2>/dev/null || true
else
  if [ -f events.jsonl ]; then
    mv events.jsonl events-0000000000-base.jsonl
  fi
  cat events-*.jsonl > events.jsonl 2>/dev/null || true
  rm -f events-0000000000-base.jsonl events-*.jsonl 2>/dev/null || true
fi

# ── Run compactor (deduplicate UPSERT_NODE events, keep latest per node ID) ──
# Uses the STREAMING compactor (readline + Maps) — the in-memory compact.js
# OOM'd at ~4GB heap on 3.7M events (compaction workflow failure 2026-09-04).
echo "Compacting events (streaming)..."
node scripts/compact-stream.js events.jsonl events-compacted.jsonl

mv events-compacted.jsonl events.jsonl

COMPACTED_LINES=$(wc -l < events.jsonl | cut -d' ' -f1)
echo "Compacted to $COMPACTED_LINES events."

# Compress the compacted base to stay under GitHub's 100MB file limit
gzip -k -f events.jsonl

# ── Push compacted memory and release lock ──────────────────────────────────
if [ "$GITHUB_ACTIONS" == "true" ]; then
  cd "$WORKTREE"
  # Clean up old tracking files
  git rm -f *.jsonl *.jsonl.gz 2>/dev/null || true
  # Add the new compacted file
  cp "$ORIG_DIR/events.jsonl.gz" .
  git add events.jsonl.gz
  # Release lock
  git rm -f yaam-compaction.lock 2>/dev/null || true
  git commit -m "Compaction complete ($COMPACTED_LINES events) — lock released"
  git push origin memory
  cd - >/dev/null
fi

rm -f yaam-compaction.lock
echo "=== Compaction Complete ==="
