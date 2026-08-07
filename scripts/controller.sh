#!/bin/bash
# Controller: orchestrates the agent pipeline, acts as circuit breaker, escalates to human.
# Triggered by workflow_run events when any agent workflow completes.
set -e

# --- Configuration ---
REPO="Redna/evol-hive"
MAX_RETRIES_ARCHITECT=3
MAX_RETRIES_DEVELOPER=2
MAX_RETRIES_DOCTOR=2
OWNER="Redna"  # GitHub username for escalation mentions

# --- Inputs from environment ---
COMPLETED_WORKFLOW="${COMPLETED_WORKFLOW}"
COMPLETED_CONCLUSION="${COMPLETED_CONCLUSION}"
COMPLETED_RUN_ID="${COMPLETED_RUN_ID}"
GH_PAT="${GH_PAT}"
GITHUB_TOKEN="${GITHUB_TOKEN}"

# --- API helpers ---
api() {
  curl -s -H "Authorization: token $GH_PAT" -H "Accept: application/vnd.github+json" "$@"
}

api_post() {
  curl -s -X POST -H "Authorization: token $GH_PAT" -H "Accept: application/vnd.github+json" "$@"
}

# --- State queries ---
get_latest_issue() {
  api "https://api.github.com/repos/$REPO/issues?state=open&labels=Status:Needs+Architecture,Status:Ready+for+Dev,Status:In+Review/QA&per_page=1" | \
    python3 -c "import sys,json; issues=json.load(sys.stdin); print(issues[0]['number'] if issues else '')" 2>/dev/null
}

get_latest_pr() {
  api "https://api.github.com/repos/$REPO/pulls?state=open&per_page=1" | \
    python3 -c "import sys,json; prs=json.load(sys.stdin); print(prs[0]['number'] if prs else '')" 2>/dev/null
}

get_pr_checks() {
  local pr_num=$1
  local head_sha=$(api "https://api.github.com/repos/$REPO/pulls/$pr_num" | python3 -c "import sys,json; print(json.load(sys.stdin)['head']['sha'])" 2>/dev/null)
  api "https://api.github.com/repos/$REPO/commits/$head_sha/check-runs" | \
    python3 -c "
import sys, json
checks = json.load(sys.stdin).get('check_runs', [])
for c in checks:
    print(f'{c[\"name\"]}|{c[\"conclusion\"] or c[\"status\"]}')
" 2>/dev/null
}

count_retries() {
  local issue_or_pr=$1  # "issues/N" or "issues/N" (PRs are also issues in the API)
  local agent=$2
  api "https://api.github.com/repos/$REPO/$issue_or_pr/comments" | \
    python3 -c "
import sys, json
comments = json.load(sys.stdin)
count = sum(1 for c in comments if f'[Controller] retry:{agent}' in c['body'])
print(count)
" 2>/dev/null
}

post_comment() {
  local target=$1  # "issues/1" or "issues/3" (PRs use issues endpoint)
  local body=$2
  api_post "https://api.github.com/repos/$REPO/$target/comments" -d "{\"body\": \"$body\"}" > /dev/null
}

dispatch_workflow() {
  local workflow_name=$1
  local issue_number=$2
  local workflow_id=""
  case $workflow_name in
    "Architect") workflow_id="327276209" ;;
    "Developer") workflow_id="327276210" ;;
    "Doctor")    workflow_id="327276211" ;;
  esac
  if [ -n "$workflow_id" ] && [ -n "$issue_number" ]; then
    api_post "https://api.github.com/repos/$REPO/actions/workflows/$workflow_id/dispatches" \
      -d "{\"ref\":\"main\",\"inputs\":{\"issue_number\":\"$issue_number\"}}" > /dev/null
    echo "Dispatched $workflow_name for issue #$issue_number"
  fi
}

# CI and QA trigger automatically via pull_request events (PR created with PAT)

# Also need PR number for Doctor
dispatch_doctor() {
  # Doctor uses check_run event, not workflow_dispatch with issue number
  # The Doctor triggers automatically on check_run failure, so we don't dispatch it
  # But we can approve pending Doctor runs if needed
  echo "Doctor triggers automatically on CI failure — no dispatch needed"
}

# --- Main decision logic ---
echo "=== Controller ==="
echo "Completed: $COMPLETED_WORKFLOW — $COMPLETED_CONCLUSION"

# Skip non-failure conclusions (skipped, neutral, cancelled)
if [ "$COMPLETED_CONCLUSION" = "skipped" ] || [ "$COMPLETED_CONCLUSION" = "neutral" ] || [ "$COMPLETED_CONCLUSION" = "cancelled" ]; then
    echo "Workflow was $COMPLETED_CONCLUSION — no action needed."
    exit 0
fi

ISSUE=$(get_latest_issue)
PR=$(get_latest_pr)
echo "Latest issue: #$ISSUE"
echo "Latest PR: #$PR"

case "$COMPLETED_WORKFLOW" in
  "Architect")
    if [ "$COMPLETED_CONCLUSION" = "success" ]; then
      post_comment "issues/$ISSUE" "## 🏗️ Architect completed\n\nSpec PR created. **Review and merge it** to continue the pipeline.\n\nAfter merging, the Developer will implement the feature."
      echo "Action: posted completion comment on issue #$ISSUE"
    else
      RETRIES=$(count_retries "issues/$ISSUE" "architect")
      if [ "$RETRIES" -lt "$MAX_RETRIES_ARCHITECT" ]; then
        post_comment "issues/$ISSUE" "[Controller] retry:architect:$((RETRIES + 1))/$MAX_RETRIES_ARCHITECT"
        dispatch_workflow "Architect" "$ISSUE"
        echo "Action: retrying Architect ($((RETRIES + 1))/$MAX_RETRIES_ARCHITECT)"
      else
        post_comment "issues/$ISSUE" "## ⚠️ Escalation: Architect failed $MAX_RETRIES_ARCHITECT times\n\n@$OWNER — the Architect agent could not complete the spec. Please review the issue and provide more context.\n\n[Controller] retry:architect:$RETRIES — escalated"
        echo "Action: escalated Architect to @$OWNER"
      fi
    fi
    ;;

  "Developer")
    if [ "$COMPLETED_CONCLUSION" = "success" ]; then
      post_comment "issues/$ISSUE" "## 🔨 Developer completed\n\nPR created. CI and QA will run automatically on the PR.\n\nOnce all checks pass, you'll be notified to review and merge."
      echo "Action: posted completion comment on issue #$ISSUE"
    else
      RETRIES=$(count_retries "issues/$ISSUE" "developer")
      if [ "$RETRIES" -lt "$MAX_RETRIES_DEVELOPER" ]; then
        post_comment "issues/$ISSUE" "[Controller] retry:developer:$((RETRIES + 1))/$MAX_RETRIES_DEVELOPER"
        dispatch_workflow "Developer" "$ISSUE"
        echo "Action: retrying Developer ($((RETRIES + 1))/$MAX_RETRIES_DEVELOPER)"
      else
        post_comment "issues/$ISSUE" "## ⚠️ Escalation: Developer failed $MAX_RETRIES_DEVELOPER times\n\n@$OWNER — the Developer agent could not implement the feature. Please review the spec and provide guidance.\n\n[Controller] retry:developer:$RETRIES — escalated"
        echo "Action: escalated Developer to @$OWNER"
      fi
    fi
    ;;

  "CI")
    if [ "$COMPLETED_CONCLUSION" = "failure" ]; then
      if [ -n "$PR" ]; then
        RETRIES=$(count_retries "issues/$PR" "doctor")
        if [ "$RETRIES" -lt "$MAX_RETRIES_DOCTOR" ]; then
          post_comment "issues/$PR" "[Controller] retry:doctor:$((RETRIES + 1))/$MAX_RETRIES_DOCTOR — CI failed, Doctor should trigger automatically"
          echo "Action: Doctor should trigger automatically on CI failure"
        else
          post_comment "issues/$PR" "## ⚠️ Escalation: Doctor exhausted $MAX_RETRIES_DOCTOR retries\n\n@$OWNER — the Doctor could not fix the CI failure after $MAX_RETRIES_DOCTOR attempts. Please review the PR.\n\n[Controller] retry:doctor:$RETRIES — escalated"
          echo "Action: escalated Doctor to @$OWNER"
        fi
      fi
    elif [ "$COMPLETED_CONCLUSION" = "success" ]; then
      if [ -n "$PR" ]; then
        # Check if QA also passed
        CHECKS=$(get_pr_checks "$PR")
        QA_STATUS=$(echo "$CHECKS" | grep -i "qa" | head -1 | cut -d'|' -f2)
        if [ "$QA_STATUS" = "success" ]; then
          post_comment "issues/$PR" "## ✅ All checks passed\n\nCI: ✅ | QA: ✅\n\n@$OWNER — PR is ready for your review and merge."
          echo "Action: notified @$OWNER that PR #$PR is ready"
        else
          echo "Action: CI passed, waiting for QA to complete"
        fi
      fi
    fi
    ;;

  "QA")
    if [ "$COMPLETED_CONCLUSION" = "success" ]; then
      if [ -n "$PR" ]; then
        # Check if CI also passed
        CHECKS=$(get_pr_checks "$PR")
        CI_STATUS=$(echo "$CHECKS" | grep -i "Type Check" | head -1 | cut -d'|' -f2)
        if [ "$CI_STATUS" = "success" ]; then
          post_comment "issues/$PR" "## ✅ All checks passed\n\nCI: ✅ | QA: ✅\n\n@$OWNER — PR is ready for your review and merge."
          echo "Action: notified @$OWNER that PR #$PR is ready"
        else
          echo "Action: QA passed, waiting for CI to complete"
        fi
      fi
    else
      if [ -n "$PR" ]; then
        post_comment "issues/$PR" "## ⚠️ QA failed\n\n@$OWNER — the QA agent encountered issues. Please review the test coverage and PR.\n\nThe QA report should be posted as a comment on this PR."
        echo "Action: escalated QA failure to @$OWNER"
      fi
    fi
    ;;

  "Doctor")
    if [ "$COMPLETED_CONCLUSION" = "success" ]; then
      if [ -n "$PR" ]; then
        post_comment "issues/$PR" "## 🩺 Doctor applied a fix\n\nThe Doctor diagnosed and fixed the CI failure. CI will re-run automatically on the pushed fix."
        echo "Action: posted Doctor completion comment on PR #$PR"
      fi
    else
      if [ -n "$PR" ]; then
        post_comment "issues/$PR" "## ⚠️ Doctor could not fix the issue\n\n@$OWNER — the Doctor agent could not resolve the CI failure. Please review the PR and the failure logs.\n\n[Controller] doctor:escalated"
        echo "Action: escalated Doctor failure to @$OWNER"
      fi
    fi
    ;;

  *)
    echo "Unknown workflow: $COMPLETED_WORKFLOW — no action taken"
    ;;
esac

echo "=== Controller complete ==="