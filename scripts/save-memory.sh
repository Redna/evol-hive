#!/bin/bash
# Save YAAM memory to the memory branch via the GitHub API.
# No branch switching — just upload the file content via the Contents API.
set -e

echo "=== Saving YAAM memory ==="

if [ ! -f events.jsonl ]; then
  echo "No events.jsonl to save."
  exit 0
fi

LINES=$(wc -l < events.jsonl)
SIZE=$(du -h events.jsonl | cut -f1)
echo "events.jsonl: $LINES events, $SIZE"

# Base64 encode the file content
ENCODED=$(base64 -w 0 events.jsonl)

# Get the current SHA of events.jsonl on the memory branch (if it exists)
SHA=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/Redna/evol-hive/contents/events.jsonl?ref=memory" 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null)

# Build the request body
if [ -n "$SHA" ]; then
  # File exists — update it
  BODY=$(python3 -c "
import json, os
print(json.dumps({
    'message': 'Update YAAM memory (run #${GITHUB_RUN_ID:-local})',
    'content': os.environ['ENCODED'],
    'branch': 'memory',
    'sha': '${SHA}'
}))
" 2>/dev/null)
else
  # File doesn't exist — create it (might need to create the branch first)
  # Try to create on the memory branch, if it fails, create the branch
  BODY=$(python3 -c "
import json, os
print(json.dumps({
    'message': 'Initialize YAAM memory',
    'content': os.environ['ENCODED'],
    'branch': 'memory'
}))
" 2>/dev/null)
fi

# Upload via the API
RESPONSE=$(curl -s -w "\n%{http_code}" -X PUT \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/Redna/evol-hive/contents/events.jsonl" \
  -d "$BODY" 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo "Memory saved successfully (HTTP $HTTP_CODE)."
elif [ "$HTTP_CODE" = "409" ] || [ "$HTTP_CODE" = "422" ]; then
    # Branch doesn't exist — create it from main first, then retry
    echo "Memory branch may not exist. Creating from main..."
    MAIN_SHA=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
      "https://api.github.com/repos/Redna/evol-hive/git/refs/heads/main" 2>/dev/null | \
      python3 -c "import sys,json; print(json.load(sys.stdin).get('object',{}).get('sha',''))" 2>/dev/null)

    if [ -n "$MAIN_SHA" ]; then
      curl -s -X POST \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/Redna/evol-hive/git/refs" \
        -d "{\"ref\":\"refs/heads/memory\",\"sha\":\"$MAIN_SHA\"}" > /dev/null 2>/dev/null

      # Remove SHA from body (new branch, no existing file)
      BODY=$(python3 -c "
import json, os
print(json.dumps({
    'message': 'Initialize YAAM memory',
    'content': os.environ['ENCODED'],
    'branch': 'memory'
}))
" 2>/dev/null)

      RETRY=$(curl -s -w "\n%{http_code}" -X PUT \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/repos/Redna/evol-hive/contents/events.jsonl" \
        -d "$BODY" 2>/dev/null)

      RETRY_CODE=$(echo "$RETRY" | tail -1)
      if [ "$RETRY_CODE" = "200" ] || [ "$RETRY_CODE" = "201" ]; then
          echo "Memory branch created and memory saved (HTTP $RETRY_CODE)."
      else
          echo "Failed to save memory after creating branch (HTTP $RETRY_CODE)."
      fi
    else
      echo "Could not get main SHA to create memory branch."
    fi
else
    echo "Failed to save memory (HTTP $HTTP_CODE)."
    echo "$RESPONSE" | head -n -1 | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))" 2>/dev/null
fi

echo "Memory save complete."