#!/bin/bash
# Save YAAM memory to the memory branch
# Usage: bash scripts/save-memory.sh
set -e

echo "=== Saving YAAM memory ==="

if [ ! -f events.jsonl ]; then
  echo "No events.jsonl to save."
  exit 0
fi

LINES=$(wc -l < events.jsonl)
SIZE=$(du -h events.jsonl | cut -f1)
echo "events.jsonl: $LINES events, $SIZE"

# Save events.jsonl to a temp location
cp events.jsonl /tmp/yaam-events-save.jsonl

# Fetch or create the memory branch
git fetch origin memory:memory 2>/dev/null || {
  echo "Creating new memory branch..."
  git checkout --orphan memory
  git reset --hard
  cp /tmp/yaam-events-save.jsonl events.jsonl
  git add events.jsonl
  git commit -m "Initialize YAAM memory"
  git push origin memory
  git checkout -
  rm /tmp/yaam-events-save.jsonl
  echo "Memory branch created and pushed."
  exit 0
}

# Update the memory branch
git checkout memory
cp /tmp/yaam-events-save.jsonl events.jsonl
git add events.jsonl

# Only commit if there are changes
if git diff --cached --quiet; then
  echo "No changes to events.jsonl — skipping commit."
else
  git commit -m "Update YAAM memory (run #${GITHUB_RUN_ID:-local})"
  
  # Push with retry (handles concurrent agent pushes)
  for i in 1 2 3; do
    if git push origin memory; then
      echo "Memory pushed successfully."
      break
    else
      echo "Push failed (attempt $i/3) — pulling and retrying..."
      git pull --rebase origin memory
    fi
  done
fi

git checkout -
rm /tmp/yaam-events-save.jsonl
echo "Memory save complete."