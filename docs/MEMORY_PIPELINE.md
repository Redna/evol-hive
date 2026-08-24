# Distributed Memory & Compaction Pipeline

> How evol-hive agents share persistent memory across CI runs using a Git-based event sourcing architecture with YAAM's append-only JSONL format, distributed locking, and automatic compaction.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  memory branch (Git)                                            │
│                                                                 │
│  events.jsonl              ← Compacted base (current state)    │
│  events-<RUN_ID>.jsonl     ← Delta from a single CI agent run  │
│  yaam-compaction.lock      ← Lock file (present only during     │
│                              compaction)                        │
└─────────────────────────────────────────────────────────────────┘
        ▲                                          │
        │ push delta                               │ fetch + merge
        │                                          │
┌───────┴──────────────┐              ┌────────────┴──────────────┐
│  save-memory.sh       │              │  restore-memory.sh       │
│  (agent finish)       │              │  (agent start)           │
│                       │              │                          │
│  1. Check lock        │              │  1. Check lock           │
│  2. Extract delta     │              │  2. Fetch memory branch  │
│     tail -n NEW_LINES │              │  3. Extract base+deltas   │
│  3. Push to memory    │              │  4. cat events-*.jsonl   │
│     (rebase retry)    │              │  5. Record start lines    │
└───────────────────────┘              └──────────────────────────┘
        ▲                                          │
        │                                    agent runs
        │                                          │
┌───────┴──────────────────────────────────────────────────────────┘
│  CI Agent (Architect / Developer / QA / Doctor / Responder)     │
│                                                                  │
│  restore-memory.sh → YAAM daemon → agent work → save-memory.sh  │
└──────────────────────────────────────────────────────────────────┘
```

## How It Works

### 1. Agent Start — `restore-memory.sh`

Before any agent runs, memory is restored from the `memory` Git branch:

```bash
# 1. Wait if compaction is running
while git ls-tree origin/memory | grep -q "yaam-compaction.lock"; do
  sleep 15
  git fetch origin memory
done

# 2. Extract base + all delta files from the memory branch
git archive origin/memory | tar -x

# 3. Rename base for consistent ordering
mv events.jsonl events-0000000000-base.jsonl

# 4. Concatenate base + all deltas → single events.jsonl
#    Because YAAM uses append-only JSONL, concatenation IS a merge.
cat events-*.jsonl > events.jsonl

# 5. Record how many lines we started with (for delta calculation later)
echo "$(wc -l < events.jsonl)" > .yaam_start_lines
```

**Key insight:** YAAM's event store is append-only JSONL — each line is an independent event (`UPSERT_NODE`, `LINK_NODES`, `DELETE_NODE`). Concatenating multiple JSONL files in chronological order produces a valid event log that the Rust daemon can replay identically to a natively merged file.

### 2. Agent Runs — YAAM Daemon

The YAAM Rust daemon starts, replays `events.jsonl` into an in-memory graph, and serves the agent via JSON-RPC over TCP:

```
Daemon startup:
  events.jsonl → replay 66K events → build graph (1448 nodes, 3452 vectors)

During agent session:
  Agent → JSON-RPC → daemon → appends new events to events.jsonl
  OS file locking (fs2::lock_exclusive) prevents corruption
```

### 3. Agent Finish — `save-memory.sh`

After the agent completes, only the **new** events are extracted and pushed as a delta:

```bash
# 1. Wait if compaction is running
while git ls-tree origin/memory | grep -q "yaam-compaction.lock"; do
  sleep 15
  git fetch origin memory
done

# 2. Calculate delta
START_LINES=$(cat .yaam_start_lines)
CURRENT_LINES=$(wc -l < events.jsonl)
NEW_LINES=$((CURRENT_LINES - START_LINES))

# 3. Extract only new events
tail -n "$NEW_LINES" events.jsonl > "events-${GITHUB_RUN_ID}.jsonl"

# 4. Push to memory branch (with rebase retry for concurrent pushes)
git push origin memory
# On failure: git pull --rebase origin memory && retry (up to 3 attempts)
```

### 4. Compaction — `run-compaction.sh`

After the pipeline completes (or on a schedule), compaction merges all deltas into a single base:

```bash
# 1. Acquire lock (local + remote on memory branch)
touch yaam-compaction.lock
git add yaam-compaction.lock && git commit && git push origin memory

#    → Any agent that starts now will wait in restore-memory.sh
#    → Any agent that finishes now will wait in save-memory.sh

# 2. Merge all deltas
cat events-*.jsonl > events.jsonl

# 3. Compact (deduplicate UPSERT_NODE events, keep latest per node ID)
node scripts/compact.js events.jsonl events-compacted.jsonl

# 4. Push compacted base
git rm -f events-*.jsonl  # Remove all delta files
cp events-compacted.jsonl events.jsonl
git add events.jsonl

# 5. Release lock
git rm -f yaam-compaction.lock
git commit -m "Compaction complete — lock released"
git push origin memory

# 6. Cleanup (also runs on failure via trap cleanup EXIT)
rm -f yaam-compaction.lock
```

## Race Condition Prevention

### The Problem

Without coordination, two scenarios can cause data loss:

1. **Agent saves during compaction:** Compaction rewrites the memory branch while `save-memory.sh` is pushing a delta → rebase conflict or lost delta.

2. **Agent restores during compaction:** Compaction is mid-way (lock acquired, base being rewritten) when a new agent starts → agent gets an incomplete or inconsistent memory state.

### The Solution — `yaam-compaction.lock`

A single lock file (`yaam-compaction.lock`) coordinates all three operations:

| Operation | Lock check | Lock behavior |
|---|---|---|
| `restore-memory.sh` (agent start) | ✅ Checks lock on memory branch | Waits until released |
| `save-memory.sh` (agent finish) | ✅ Checks lock on memory branch | Waits until released |
| `run-compaction.sh` (compaction) | ✅ Creates lock | Acquires before compacting |
| `run-compaction.sh` (failure) | ✅ `trap cleanup EXIT` | Releases lock even on failure |

### Lock Lifecycle

```
 ┌──────────────────────────────────────────────────────────┐
 │  COMPACTION                                              │
 │                                                          │
 │  1. touch yaam-compaction.lock (local)                   │
 │  2. git add + commit + push to memory branch (CI)        │
 │     ──────────────────────────────────────────────────    │
 │     ┌─ NEW AGENT ──────────────────────────────────┐     │
 │     │  restore-memory.sh                           │     │
 │     │  while git ls-tree | grep yaam-compaction    │     │
 │     │    sleep 15  ← waits                         │     │
 │     └──────────────────────────────────────────────┘     │
 │     ┌─ FINISHING AGENT ───────────────────────────┐     │
 │     │  save-memory.sh                              │     │
 │     │  while git ls-tree | grep yaam-compaction    │     │
 │     │    sleep 15  ← waits                         │     │
 │     └──────────────────────────────────────────────┘     │
 │     ──────────────────────────────────────────────────    │
 │  3. Merge deltas: cat events-*.jsonl                     │
 │  4. Compact: node scripts/compact.js                     │
 │  5. Push compacted base to memory branch                 │
 │  6. git rm yaam-compaction.lock + push                   │
 │  7. rm yaam-compaction.lock (local)                      │
 │     ──────────────────────────────────────────────────    │
 │     ┌─ WAITING AGENTS RESUME ─────────────────────┐     │
 │     │  restore-memory.sh → no lock → proceeds     │     │
 │     │  save-memory.sh    → no lock → pushes delta  │     │
 │     └──────────────────────────────────────────────┘     │
 └──────────────────────────────────────────────────────────┘
```

## Why Auto-Compaction Is Disabled

The YAAM daemon's built-in auto-compaction (commit `19cf4d8`) is **intentionally disabled** via `YAAM_DISABLE_AUTO_COMPACT=true`:

- Auto-compaction rewrites `events.jsonl` (reducing line count via `synthesize_current_state()`)
- `save-memory.sh` computes deltas as `tail -n $((CURRENT_LINES - START_LINES))`
- If compaction reduces `CURRENT_LINES` below `START_LINES`, the delta calculation produces a negative number → no events saved → **data loss**

Instead, compaction runs **offline** (after all agents finish) via `run-compaction.sh`, which:
1. Uses the JS compactor (`compact.js`) — no daemon needed
2. Acquires the lock so no agents are running
3. Merges and compacts safely
4. Pushes the clean base

## Compaction Triggers

| Trigger | When | How |
|---|---|---|
| **Pipeline Phase 6** | After code PR merge | `pipeline.sh` calls `run-compaction.sh` |
| **Scheduled** | Every 6 hours | `compaction.yml` cron job |
| **Manual** | Anytime | `gh workflow run compaction.yml` or `bash scripts/run-compaction.sh` |

## Files Involved

| File | Role |
|---|---|
| `scripts/restore-memory.sh` | Fetch memory branch, merge base + deltas, record start lines |
| `scripts/save-memory.sh` | Extract delta (new events only), push to memory branch |
| `scripts/run-compaction.sh` | Acquire lock, merge all deltas, compact, release lock |
| `scripts/compact.js` | Deduplicate UPSERT_NODE events (keep latest per node ID) |
| `scripts/pipeline.sh` | Pipeline orchestrator — Phase 6 runs compaction |
| `.github/workflows/compaction.yml` | Scheduled + manual compaction workflow |
| `.github/workflows/architect.yml` | Restore + save wired in |
| `.github/workflows/developer.yml` | Restore + save wired in |
| `.github/workflows/qa.yml` | Restore + save wired in |
| `.github/workflows/doctor.yml` | Restore + save wired in |
| `.github/workflows/responder.yml` | Restore + save wired in |

## Memory Branch Structure

```
memory branch
├── events.jsonl                    # Compacted base (current graph state)
├── events-1787171547.jsonl          # Delta from CI run #1787171547
├── events-32710303752.jsonl         # Delta from CI run #32710303752
├── events-32710310496.jsonl         # Delta from CI run #32710310496
├── events-32711222084.jsonl         # Delta from CI run #32711222084
└── yaam-compaction.lock             # Present ONLY during compaction
```

After compaction, all `events-*.jsonl` delta files are merged into `events.jsonl` and removed. The branch contains only the single compacted base file.

## Concurrent Push Handling

When multiple agents finish simultaneously and both try to push to the `memory` branch:

```bash
# save-memory.sh retry loop
for i in 1 2 3; do
  if git push origin memory 2>/dev/null; then
    break
  else
    git pull --rebase origin memory  # Rebase delta on top of other agent's delta
    # Retry
  fi
done
```

Since each agent pushes a **uniquely named** delta file (`events-<RUN_ID>.jsonl`), the rebase never produces conflicts — both delta files coexist on the memory branch.

## Performance

| Metric | Before Compaction | After Compaction |
|---|---|---|
| File size | 240MB | 76MB |
| Event count | 164K | 100K |
| Delta files | 4 | 0 |
| Daemon startup | ~8s (replay 164K events) | ~5s (replay 100K events) |
| Graph nodes | 1448 | 1448 (unchanged — compaction deduplicates events, not nodes) |