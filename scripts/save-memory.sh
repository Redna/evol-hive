#!/bin/bash
# Save YAAM memory delta to the memory branch using a git worktree.
set -e

echo "=== Saving YAAM memory ==="

if [ ! -f events.jsonl ]; then
  echo "No events.jsonl to save."
  exit 0
fi

START_LINES=$(cat .yaam_start_lines 2>/dev/null || echo "0")
CURRENT_LINES=$(wc -l < events.jsonl | cut -d' ' -f1)
NEW_LINES=$((CURRENT_LINES - START_LINES))

if [ "$NEW_LINES" -le 0 ]; then
  echo "No new events to save."
  exit 0
fi

echo "Extracting delta: $NEW_LINES new events."

# ── Compaction lock check (distributed safety) ──────────────────────────────
# Wait if a compaction is running on the memory branch before pushing our
# delta. This prevents a race where compaction rewrites the base while we
# push our delta, which could cause a rebase conflict or data loss.
if [ "$GITHUB_ACTIONS" == "true" ]; then
  while git ls-tree origin/memory 2>/dev/null | grep -q "yaam-compaction.lock"; do
    echo "Compaction in progress on memory branch. Waiting 15s before saving..."
    sleep 15
    git fetch origin memory:refs/remotes/origin/memory 2>/dev/null || true
  done
else
  while [ -f "yaam-compaction.lock" ]; do
    echo "Local compaction in progress. Waiting 10s before saving..."
    sleep 10
  done
fi

WORKTREE="/tmp/yaam-memory-worktree"
rm -rf "$WORKTREE"

# Create or attach to orphan branch
if git worktree add "$WORKTREE" memory 2>/dev/null; then
  echo "Using existing memory branch"
else
  echo "Creating new memory branch"
  git worktree add --detach "$WORKTREE" HEAD
  cd "$WORKTREE"
  git checkout --orphan memory
  git reset --hard
  cd - >/dev/null
fi

# Create a file containing ONLY the new memories from this agent
UNIQUE_FILE="events-${GITHUB_RUN_ID:-$(date +%s)}.jsonl"
tail -n "$NEW_LINES" events.jsonl > "$WORKTREE/$UNIQUE_FILE"

# Commit and push
cd "$WORKTREE"
git add "$UNIQUE_FILE"
git commit -m "Update YAAM memory delta (run #${GITHUB_RUN_ID:-local})"

for i in 1 2 3; do
  if git push origin memory 2>/dev/null; then
    echo "Memory pushed successfully."
    break
  else
    echo "Push failed (attempt $i/3) — pulling and retrying..."
    git pull --rebase origin memory 2>/dev/null || true
  fi
done

cd - >/dev/null
git worktree remove "$WORKTREE" --force 2>/dev/null || rm -rf "$WORKTREE"

echo "Memory save complete."