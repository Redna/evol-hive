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

# Ensure git identity is set (required for committing to memory branch)
git config user.email "evol-hive-agent[bot]@users.noreply.github.com" 2>/dev/null || true
git config user.name "evol-hive-agent[bot]" 2>/dev/null || true

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

# ── Size-triggered compaction (incident 2026-09-05 19:26 + 23:00) ────────────
# Two failure modes: (a) old-daamon runs appended amplified deltas, (b) the
# branch accumulates DELTA FILES (events-*.jsonl) across runs — the original
# check measured only events.jsonl and missed them (643MB restore = 41MB base
# + ~600MB of deltas). Measure the TOTAL branch size across all files.
MEM_TOTAL=$(git ls-tree -r -l origin/memory 2>/dev/null | awk '{sum += $4} END {print sum + 0}')
THRESHOLD=$((100 * 1048576))  # 100MB across ALL memory-branch files
if [ "${MEM_TOTAL:-0}" -gt "$THRESHOLD" ]; then
  SIZE_MB=$((MEM_TOTAL / 1048576))
  echo "Memory branch total is ${SIZE_MB}MB (> 100MB across all files) — triggering compaction."
  if [ -n "${GH_PAT:-}" ]; then
    gh workflow run compaction.yml --ref main || echo "⚠️ Compaction trigger failed — branch stays bloated until the next cron run."
  else
    echo "⚠️ No GH_PAT available to trigger compaction — branch stays bloated until the next cron run."
  fi
else
  echo "Memory branch size OK ($((MEM_TOTAL / 1048576))MB total)."
fi

echo "Memory save complete."