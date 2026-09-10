# Implementation Notes — Spec 045 (Assembly Conversation Wiring) — PR #172

> Note: the YAAM daemon IS reachable in this environment (local TCP daemon on
> `127.0.0.1:43535`, port recorded in `.yaam/daemon.port`), but it exposes a
> single `search` method (semantic index over the workspace) — no note-write
> method exists (probed ~20 candidate method names: `workspace_*`, `note_*`,
> `scratchpad_*`, `memory_*`, `save/put/append` — all `Method not found`).
> Findings are recorded here per the notes-directory convention; this file is
> itself YAAM-indexed (docs sections are in the index), so it is discoverable
> via `yaam_search`.

## What was built

Spec 045 / issue #165 — the two missing wires in `examples/assembly.ts` that
left every spec 033/043/044 conversation capability dormant in live runs:

- **R1** (`examples/assembly.ts`, `assembleCognitionStack`):
  `CognitiveToolExecutorImpl` is now constructed with
  `conversationBridge: core.conversationManager` — the exact
  `ConversationManagerImpl` `createEngineCore` built (instance identity, no
  second manager). `talk_to` joins/opens real threads via spec 033 R1/R3
  `openOrContribute`; the relationship delta is a deterministic function of
  the conversation's aggregate sentiment (spec 033 R6) instead of the legacy
  blind `trust=+2 familiarity=+5`.
- **R2** (`examples/assembly.ts`, `assembleCognitionStack`):
  `social.setConversationManager(core.conversationManager)` on the sim's
  SocialManager — the instance passed as the executor's `socialBridge` AND
  consumed by the perception bridge. Exactly one SocialManager now holds both
  roles, so `getConversationsAwaitingAgentReply` (spec 043 pending-address
  line) and spec 044 reciprocity counters come alive in live runs.
- **R3**: perception provider wiring untouched — no re-wire, no second
  `ConversationManagerImpl` (inherited wiring from `createEngineCore` was
  already correct; the root cause was the sim's REPLACEMENT SocialManager
  overwriting `core.bridges.perception`'s social manager via
  `setSocialManager(social)` without carrying the conversation delegate).
- **R4**: the legacy `+5/+2` fallback inside `executeTalkTo` (cognition) is
  untouched — unwired contexts keep it (spec 033 AC-14).

## TDD flow (tests written BEFORE implementation)

Branch `feature/165-assembly-conversation-wiring` (resumed from the QA
audit's commit `03861f0`, which carried the spec-045 QA suite with 5
`it.todo()` scaffolds for exactly this fix PR).

1. Commit `4843dac` — converted the two unit-testable todos into active
   tests in `examples/tests/spec-045-assembly-conversation-wiring.test.ts`:
   - **AC-1 (R1)**: talk_to through the PRODUCTION-constructed
     `stack.cognitiveToolExecutor` (no manual wiring) opens a real
     conversation in `core.conversationManager`; `conversationUpdated` true;
     same thread visible via the sim's SocialManager (instance identity).
   - **AC-2 (R2)**: the sim's SocialManager carries the conversation delegate
     with no manual wiring; the pending-address query flows through
     `core.bridges.perception` (which consumes the same socialBridge).
   - **AC-6**: new static grep assertion pinning both fix lines
     (`conversationBridge: core.conversationManager` +
     `social.setConversationManager(core.conversationManager)` in
     examples/assembly.ts).
   - The three live-run-evidence todos (real-LLM `[social]` telemetry,
     events.jsonl, live `receivedCount`) stay `it.todo` — manual real-LLM
     evidence, to be recorded on issue #165 (deterministic proxies are the
     section-4 machinery tests + section-5 production-wiring tests).
   - Confirmed RED for the right reasons: `conversationUpdated` false (no
     bridge), delegate query `[]` (no wiring), grep misses both lines.
2. Commit `dfe2a5a` — the implementation (12 added lines in
   `examples/assembly.ts`). GREEN: 16 passed / 3 todo in the spec-045 suite.

## Verification (AC-5)

- `pnpm test`: **2,323 passed / 0 failed** (shared 342, visualizer 48,
  memory 101, cognition 883 + 1 skipped, engine 783, examples 151, cli 15;
  todos/skips as reported by vitest). Spec 044's exactly-once counter tests
  and spec 033 lifecycle/bridge tests pass unmodified.
- `pnpm typecheck` / `pnpm lint` / `pnpm format:check`: clean.
- `pnpm build`: success.

## PR

- **PR #172** — "feat: Assembly Conversation Wiring — connect the conversation
  bridge in examples/assembly.ts" (branch
  `feature/165-assembly-conversation-wiring` → `main`). Opened with the
  required `GH_TOKEN` override; spec status row 045 in `docs/specs/INDEX.md`
  set to 🔍 In Review (row was missing entirely — added; the stale
  Spec Status Summary was also recounted to match the actual rows: 61 total).

## Environment notes (for future sessions)

- The YAAM daemon exposes only `initialize` + `search` over TCP JSON-RPC
  (probed extensively). Write notes as `docs/specs/notes/*.md` files — they
  are indexed by the reconciler and surface in `yaam_search`.
- `pnpm test` in a fresh checkout needs `pnpm build` first (examples resolve
  workspace packages to built `dist/`) — matches the spec-035 QA note.
- `examples/dynamic-world.ts` has a pre-existing prettier violation on main;
  CI's `format:check` scope covers only `packages/*/src` and `packages/*/tests`,
  so it does not gate this PR (left untouched — out of scope).

## Remaining for full done

- AC-1/AC-3/AC-4 live-run evidence: one real-LLM sim run confirming
  `[social]` non-legacy deltas, the pending-address line in perception, and
  the exchange in `events.jsonl` (record evidence on issue #165; the three
  `it.todo` scaffolds in the QA suite track this).
- CI on PR #172 + merge.