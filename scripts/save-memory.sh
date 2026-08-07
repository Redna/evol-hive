#!/bin/bash
# Save YAAM memory to the memory branch using a git worktree.
# No branch switching, no API size limits, no checkout conflicts.
set -e

echo "=== Saving YAAM memory ==="

if [ ! -f events.jsonl ]; then
  echo "No events.jsonl to save."
  exit 0
fi

LINES=$(wc -l < events.jsonl)
SIZE=$(du -h events.jsonl | cut -f1)
echo "events.jsonl: $LINES events, $SIZE"

# Strip embedding arrays from events before saving.
# Embeddings are ~90% of the file size and are recomputed from the ONNX
# model on every run. Only workspace/scratchpad notes need to persist.
python3 -c "
import json, sys
with open('events.jsonl', 'r') as f:
    for line in f:
        try:
            event = json.loads(line)
            payload = event.get('payload', {})
            props = payload.get('properties', {})
            if 'embedding' in props:
                del props['embedding']
            print(json.dumps(event))
        except:
            print(line, end='')
" > /tmp/events-stripped.jsonl

STRIPPED_SIZE=$(du -h /tmp/events-stripped.jsonl | cut -f1)
echo "Stripped embeddings: $SIZE → $STRIPPED_SIZE"

# Create a temporary worktree for the memory branch
WORKTREE="/tmp/yaam-memory-worktree"
rm -rf "$WORKTREE"

# Try to add existing memory branch, or create a new orphan one
if git worktree add "$WORKTREE" memory 2>/dev/null; then
  echo "Using existing memory branch"
else
  echo "Creating new memory branch"
  git worktree add --detach "$WORKTREE" HEAD
  cd "$WORKTREE"
  git checkout --orphan memory
  git reset --hard
  cd -  # back to main worktree
fi

# Copy stripped events.jsonl to the worktree
cp /tmp/events-stripped.jsonl "$WORKTREE/events.jsonl"

# Commit and push from the worktree
cd "$WORKTREE"
git add events.jsonl

if git diff --cached --quiet; then
  echo "No changes to events.jsonl — skipping commit."
else
  git commit -m "Update YAAM memory (run #${GITHUB_RUN_ID:-local})"

  # Push with retry (handles concurrent agent pushes)
  for i in 1 2 3; do
    if git push origin memory 2>/dev/null; then
      echo "Memory pushed successfully."
      break
    else
      echo "Push failed (attempt $i/3) — pulling and retrying..."
      git pull --rebase origin memory 2>/dev/null || true
    fi
  done
fi

cd -  # back to main worktree

# Clean up the worktree
git worktree remove "$WORKTREE" --force 2>/dev/null || rm -rf "$WORKTREE"

echo "Memory save complete."