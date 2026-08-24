#!/bin/bash
# Pipeline Orchestrator: runs the full agent pipeline in one workflow.
# Dispatches agents, polls for completion, handles retries, escalates to human.
set -e

# --- Configuration ---
REPO="Redna/evol-hive"
OWNER="Redna"
ISSUE_NUMBER="${ISSUE_NUMBER}"
PAT="${GH_PAT}"
TOKEN="${APP_TOKEN}"

# Workflow IDs
ARCHITECT_ID="327276209"
DEVELOPER_ID="327276210"
CI_ID="326749512"
QA_ID="327684302"
DOCTOR_ID="327276211"

# Limits
MAX_RETRIES_ARCHITECT=3
MAX_RETRIES_DEVELOPER=2
MAX_RETRIES_DOCTOR=2
POLL_INTERVAL=30        # seconds between polls for workflow completion
PR_POLL_INTERVAL=60     # seconds between polls for PR merge
PR_WAIT_TIMEOUT=3600    # 60 minutes max waiting for human to merge PR

# --- API helpers ---
api() {
  curl -s -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" "$@"
}

api_pat() {
  curl -s -H "Authorization: token $PAT" -H "Accept: application/vnd.github+json" "$@"
}

api_post() {
  curl -s -X POST -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" "$@"
}

api_post_pat() {
  curl -s -X POST -H "Authorization: token $PAT" -H "Accept: application/vnd.github+json" "$@"
}

post_comment() {
  local target=$1; local body=$2
  api_post "https://api.github.com/repos/$REPO/$target/comments" -d "{\"body\": \"$body\"}" > /dev/null
}

approve_pr() {
  local pr=$1; local body=$2
  api_post "https://api.github.com/repos/$REPO/pulls/$pr/reviews" \
    -d "{\"event\":\"APPROVE\",\"body\":\"$body\"}" > /dev/null
}

dispatch_workflow() {
  local id=$1; shift
  local inputs="{}"
  if [ $# -gt 0 ]; then
    inputs="{\"issue_number\":\"$1\"}"
  fi
  api_post "https://api.github.com/repos/$REPO/actions/workflows/$id/dispatches" \
    -d "{\"ref\":\"main\",\"inputs\":$inputs}" > /dev/null
}

dispatch_pr_workflow() {
  local id=$1; local pr=$2
  api_post "https://api.github.com/repos/$REPO/actions/workflows/$id/dispatches" \
    -d "{\"ref\":\"main\",\"inputs\":{\"pr_number\":\"$pr\"}}" > /dev/null
}

# --- Polling functions ---

# Wait for the latest run of a workflow to complete, return its conclusion
wait_for_workflow() {
  local workflow_name=$1
  local max_wait=3600  # 60 min max per agent
  local waited=0

  echo "  Waiting for $workflow_name to complete..."

  while [ $waited -lt $max_wait ]; do
    sleep $POLL_INTERVAL
    waited=$((waited + POLL_INTERVAL))

    # Get the latest run of this workflow
    RESULT=$(api "https://api.github.com/repos/$REPO/actions/runs?per_page=5" 2>/dev/null | python3 -c "
import sys, json
for r in json.load(sys.stdin)['workflow_runs']:
    if r['name'] == '$workflow_name' and r['status'] == 'completed':
        print(f'{r[\"conclusion\"]}|{r[\"id\"]}')
        break
" 2>/dev/null)

    if [ -n "$RESULT" ]; then
      CONCLUSION=$(echo "$RESULT" | cut -d'|' -f1)
      RUN_ID=$(echo "$RESULT" | cut -d'|' -f2)
      echo "  $workflow_name completed: $CONCLUSION (run $RUN_ID, waited ${waited}s)"
      echo "$CONCLUSION"
      return 0
    fi
  done

  echo "  $workflow_name timed out after ${max_wait}s"
  echo "timeout"
  return 1
}

# Find the latest open PR from a branch prefix
find_pr() {
  local branch_prefix=$1
  api "https://api.github.com/repos/$REPO/pulls?state=open&per_page=10" 2>/dev/null | python3 -c "
import sys, json
for pr in json.load(sys.stdin):
    if pr['head']['ref'].startswith('$branch_prefix'):
        print(f'{pr[\"number\"]}|{pr[\"head\"][\"ref\"]}')
        break
" 2>/dev/null
}

# Wait for a PR to be merged, returns 0 if merged, 1 if timeout
wait_for_pr_merge() {
  local pr_number=$1
  local label=$2
  local waited=0

  echo "  Waiting for human to merge PR #$pr_number ($label)..."

  while [ $waited -lt $PR_WAIT_TIMEOUT ]; do
    sleep $PR_POLL_INTERVAL
    waited=$((waited + PR_POLL_INTERVAL))

    STATE=$(api "https://api.github.com/repos/$REPO/pulls/$pr_number" 2>/dev/null | \
      python3 -c "import sys,json; pr=json.load(sys.stdin); print('merged' if pr.get('merged') else pr['state'])" 2>/dev/null)

    if [ "$STATE" = "merged" ]; then
      echo "  PR #$pr_number merged after ${waited}s"
      return 0
    fi

    # Post a reminder every 15 minutes
    if [ $((waited % 900)) -eq 0 ] && [ $waited -gt 0 ]; then
      post_comment "issues/$pr_number" "⏰ Reminder: PR #$pr_number is waiting for your review and merge."
    fi
  done

  echo "  PR #$pr_number merge timed out after ${waited}s"
  return 1
}

# Check if all required check runs on a PR have passed
check_pr_status() {
  local pr_number=$1
  local head_sha=$(api "https://api.github.com/repos/$REPO/pulls/$pr_number" 2>/dev/null | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['head']['sha'])" 2>/dev/null)

  api "https://api.github.com/repos/$REPO/commits/$head_sha/check-runs" 2>/dev/null | python3 -c "
import sys, json
checks = json.load(sys.stdin).get('check_runs', [])
ci_pass = False
qa_pass = False
for c in checks:
    name = c['name'].lower()
    concl = c.get('conclusion', '')
    if 'type check' in name or 'build' in name or 'test' in name:
        if concl == 'success': ci_pass = True
    if 'qa' in name:
        if concl == 'success': qa_pass = True
if ci_pass and qa_pass:
    print('all_pass')
elif ci_pass:
    print('ci_only')
elif qa_pass:
    print('qa_only')
else:
    print('none')
" 2>/dev/null
}

# --- Pipeline phases ---

echo "============================================"
echo "  PIPELINE STARTED — Issue #$ISSUE_NUMBER"
echo "============================================"

# ============================================================
# PHASE 1: ARCHITECT
# ============================================================
echo ""
echo "--- Phase 1: Architect ---"

ARCH_RETRIES=0
ARCH_SUCCESS=false

while [ $ARCH_RETRIES -lt $MAX_RETRIES_ARCHITECT ]; do
  ARCH_RETRIES=$((ARCH_RETRIES + 1))
  echo "  Dispatching Architect (attempt $ARCH_RETRIES/$MAX_RETRIES_ARCHITECT)..."
  dispatch_workflow "$ARCHITECT_ID" "$ISSUE_NUMBER"
  sleep 10  # wait for the run to register

  RESULT=$(wait_for_workflow "Architect")

  if [ "$RESULT" = "success" ]; then
    ARCH_SUCCESS=true
    echo "  ✅ Architect succeeded"
    break
  else
    echo "  ❌ Architect failed ($RESULT), retrying..."
  fi
done

if [ "$ARCH_SUCCESS" = "false" ]; then
  post_comment "issues/$ISSUE_NUMBER" "## ⚠️ Pipeline: Architect failed $MAX_RETRIES_ARCHITECT times\n\n@$OWNER — the Architect could not complete the spec. Please review issue #$ISSUE_NUMBER."
  echo "  PIPELINE ABORTED: Architect failed"
  exit 1
fi

# Find the spec PR
SPEC_PR=$(find_pr "spec/")
if [ -z "$SPEC_PR" ]; then
  post_comment "issues/$ISSUE_NUMBER" "## ⚠️ Pipeline: No spec PR found\n\n@$OWNER — the Architect completed but no spec PR was created. Please check."
  echo "  PIPELINE ABORTED: No spec PR"
  exit 1
fi

SPEC_PR_NUM=$(echo "$SPEC_PR" | cut -d'|' -f1)
post_comment "issues/$ISSUE_NUMBER" "## 🏗️ Architect completed\n\nSpec PR #$SPEC_PR_NUM created. Please review and merge to continue the pipeline."
echo "  Spec PR #$SPEC_PR_NUM created, waiting for merge..."

# ============================================================
# PHASE 2: WAIT FOR SPEC PR MERGE
# ============================================================
echo ""
echo "--- Phase 2: Wait for spec PR merge ---"

if ! wait_for_pr_merge "$SPEC_PR_NUM" "spec"; then
  post_comment "issues/$ISSUE_NUMBER" "## ⏰ Pipeline: Spec PR merge timed out\n\n@$OWNER — please merge spec PR #$SPEC_PR_NUM and re-dispatch the pipeline."
  echo "  PIPELINE PAUSED: Spec PR not merged"
  exit 0
fi

echo "  ✅ Spec PR merged"

# ============================================================
# PHASE 3: DEVELOPER
# ============================================================
echo ""
echo "--- Phase 3: Developer ---"

# Update issue label
api_post "https://api.github.com/repos/$REPO/issues/$ISSUE_NUMBER/labels" \
  -d '{"labels":["Status: Ready for Dev"]}' > /dev/null 2>/dev/null

DEV_RETRIES=0
DEV_SUCCESS=false

while [ $DEV_RETRIES -lt $MAX_RETRIES_DEVELOPER ]; do
  DEV_RETRIES=$((DEV_RETRIES + 1))
  echo "  Dispatching Developer (attempt $DEV_RETRIES/$MAX_RETRIES_DEVELOPER)..."
  dispatch_workflow "$DEVELOPER_ID" "$ISSUE_NUMBER"
  sleep 10

  RESULT=$(wait_for_workflow "Developer")

  if [ "$RESULT" = "success" ]; then
    DEV_SUCCESS=true
    echo "  ✅ Developer succeeded"
    break
  else
    echo "  ❌ Developer failed ($RESULT), retrying..."
  fi
done

if [ "$DEV_SUCCESS" = "false" ]; then
  post_comment "issues/$ISSUE_NUMBER" "## ⚠️ Pipeline: Developer failed $MAX_RETRIES_DEVELOPER times\n\n@$OWNER — the Developer could not implement the feature. Please review."
  echo "  PIPELINE ABORTED: Developer failed"
  exit 1
fi

# Find the code PR
CODE_PR=$(find_pr "feature/")
if [ -z "$CODE_PR" ]; then
  post_comment "issues/$ISSUE_NUMBER" "## ⚠️ Pipeline: No code PR found\n\n@$OWNER — the Developer completed but no code PR was created. Please check."
  echo "  PIPELINE ABORTED: No code PR"
  exit 1
fi

CODE_PR_NUM=$(echo "$CODE_PR" | cut -d'|' -f1)
post_comment "issues/$ISSUE_NUMBER" "## 🔨 Developer completed\n\nCode PR #$CODE_PR_NUM created. Running CI and QA..."
echo "  Code PR #$CODE_PR_NUM created"

# ============================================================
# PHASE 4: CI + QA
# ============================================================
echo ""
echo "--- Phase 4: CI + QA ---"

# Dispatch CI and QA
dispatch_pr_workflow "$CI_ID" "$CODE_PR_NUM"
dispatch_pr_workflow "$QA_ID" "$CODE_PR_NUM"
echo "  Dispatched CI and QA for PR #$CODE_PR_NUM"

# Wait for both to complete
CI_DONE=false
QA_DONE=false
CI_RESULT=""
QA_RESULT=""
PHASE4_WAITED=0
PHASE4_TIMEOUT=3600

echo "  Waiting for CI and QA to complete..."

while [ $PHASE4_WAITED -lt $PHASE4_TIMEOUT ]; do
  sleep $POLL_INTERVAL
  PHASE4_WAITED=$((PHASE4_WAITED + POLL_INTERVAL))

  STATUS=$(check_pr_status "$CODE_PR_NUM")

  if [ "$STATUS" = "all_pass" ]; then
    echo "  ✅ Both CI and QA passed"
    approve_pr "$CODE_PR_NUM" "All checks passed. CI ✅ | QA ✅ — approved by Pipeline Orchestrator."
    post_comment "issues/$CODE_PR_NUM" "## ✅ All checks passed\n\nCI: ✅ | QA: ✅\n\n@$OWNER — PR is ready for your review and merge."
    post_comment "issues/$ISSUE_NUMBER" "## ✅ CI + QA passed\n\nPR #$CODE_PR_NUM is approved and ready for merge."
    CI_DONE=true; QA_DONE=true
    break
  fi

  # Check for failures
  HEAD_SHA=$(api "https://api.github.com/repos/$REPO/pulls/$CODE_PR_NUM" 2>/dev/null | \
    python3 -c "import sys,json; print(json.load(sys.stdin)['head']['sha'])" 2>/dev/null)

  FAILURES=$(api "https://api.github.com/repos/$REPO/commits/$HEAD_SHA/check-runs" 2>/dev/null | python3 -c "
import sys, json
for c in json.load(sys.stdin).get('check_runs', []):
    if c.get('conclusion') == 'failure' and c['name'] not in ['GitGuardian Security Checks']:
        print(f'{c[\"name\"]}|{c[\"conclusion\"]}')
" 2>/dev/null)

  if [ -n "$FAILURES" ]; then
    echo "  ❌ Check failure detected: $FAILURES"
    
    # Check if Doctor already ran
    DOC_RESULT=$(wait_for_workflow "Doctor" 2>/dev/null || echo "not_run")
    
    if [ "$DOC_RESULT" = "not_run" ] || [ "$DOC_RESULT" = "failure" ]; then
      echo "  Dispatching Doctor..."
      # Doctor triggers on check_run failure, but as fallback we note it
      post_comment "issues/$CODE_PR_NUM" "## 🩺 CI failure detected\n\nDoctor should trigger automatically. If not, the failure needs manual review."
      
      # Wait for Doctor to complete (it triggers via check_run event)
      DOC_WAITED=0
      while [ $DOC_WAITED -lt 600 ]; do
        sleep $POLL_INTERVAL
        DOC_WAITED=$((DOC_WAITED + POLL_INTERVAL))
        # Check if CI passed after Doctor's fix
        STATUS=$(check_pr_status "$CODE_PR_NUM")
        if [ "$STATUS" = "all_pass" ]; then
          echo "  ✅ Doctor fixed the issue, all checks pass"
          approve_pr "$CODE_PR_NUM" "All checks passed after Doctor fix. CI ✅ | QA ✅"
          post_comment "issues/$CODE_PR_NUM" "## ✅ All checks passed (after Doctor fix)\n\n@$OWNER — PR is ready for merge."
          CI_DONE=true; QA_DONE=true
          break 2
        fi
      done
      
      # Doctor didn't fix it in time
      post_comment "issues/$CODE_PR_NUM" "## ⚠️ CI failure not resolved\n\n@$OWNER — the CI failure could not be automatically fixed. Please review PR #$CODE_PR_NUM."
      echo "  PIPELINE PAUSED: CI failure not resolved"
      exit 1
    fi
  fi
done

if [ "$CI_DONE" = "false" ]; then
  post_comment "issues/$CODE_PR_NUM" "## ⏰ Pipeline: CI/QA timed out\n\n@$OWNER — CI or QA did not complete in time. Please check PR #$CODE_PR_NUM."
  echo "  PIPELINE PAUSED: CI/QA timeout"
  exit 1
fi

# ============================================================
# PHASE 5: WAIT FOR CODE PR MERGE
# ============================================================
echo ""
echo "--- Phase 5: Wait for code PR merge ---"

if ! wait_for_pr_merge "$CODE_PR_NUM" "code"; then
  post_comment "issues/$ISSUE_NUMBER" "## ⏰ Pipeline: Code PR merge timed out\n\n@$OWNER — please merge code PR #$CODE_PR_NUM."
  echo "  PIPELINE PAUSED: Code PR not merged"
  exit 0
fi

echo "  ✅ Code PR merged"

# ============================================================
# PHASE 6: MEMORY COMPACTION
# ============================================================
# After all agents have saved their deltas to the memory branch,
# run compaction to merge all deltas into a single base file.
# This acquires a lock on the memory branch so that any agents that
# start during compaction will wait in restore-memory.sh.
echo ""
echo "--- Phase 6: Memory Compaction ---"

# Fetch the latest memory branch
git fetch origin memory:refs/remotes/origin/memory 2>/dev/null || true

# Count delta files on the memory branch
DELTA_COUNT=$(git ls-tree origin/memory --name-only 2>/dev/null | grep -c 'events-.*\.jsonl' || echo "0")

if [ "$DELTA_COUNT" -gt 0 ]; then
  echo "  Found $DELTA_COUNT delta file(s) on memory branch. Running compaction..."

  # Run compaction — this acquires a lock, merges deltas, compacts, and releases the lock
  # Any agent that starts during compaction will wait in restore-memory.sh
  # Any agent that finishes during compaction will wait in save-memory.sh
  bash scripts/run-compaction.sh 2>&1 || {
    echo "  ⚠️ Compaction failed — deltas will accumulate until next compaction run."
  }
else
  echo "  No delta files to compact. Memory branch is clean."
fi

# ============================================================
# DONE
# ============================================================
echo ""
echo "============================================"
echo "  PIPELINE COMPLETE — Issue #$ISSUE_NUMBER"
echo "============================================"

post_comment "issues/$ISSUE_NUMBER" "## 🎉 Pipeline complete\n\nIssue #$ISSUE_NUMBER has been fully processed:\n- Spec drafted and merged\n- Implementation built and tested\n- CI + QA passed\n- Code PR merged\n\nFeature is now on main."