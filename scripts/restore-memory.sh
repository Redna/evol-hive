#!/bin/bash
# Restore YAAM memory from the memory branch via the GitHub API.
# No branch switching needed — just fetch the file content.
set -e

echo "=== Restoring YAAM memory ==="

# Fetch events.jsonl from the memory branch via the API
RESPONSE=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/Redna/evol-hive/contents/events.jsonl?ref=memory" 2>/dev/null)

# Check if the file exists
CONTENT=$(echo "$RESPONSE" | python3 -c "
import sys, json, base64
try:
    d = json.load(sys.stdin)
    if 'content' in d:
        content = base64.b64decode(d['content']).decode('utf-8')
        print(content)
except:
    pass
" 2>/dev/null)

if [ -n "$CONTENT" ]; then
    echo "$CONTENT" > events.jsonl
    LINES=$(wc -l < events.jsonl)
    SIZE=$(du -h events.jsonl | cut -f1)
    echo "Restored events.jsonl: $LINES events, $SIZE"
else
    echo "No events.jsonl on memory branch — starting fresh."
    touch events.jsonl
fi