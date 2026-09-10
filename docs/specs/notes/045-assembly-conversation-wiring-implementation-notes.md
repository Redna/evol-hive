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

---

## Session 2 (2026-09-10, resumed) — live validation ran; two cognition-layer gaps discovered

Resumed with PR #172 open and all commits pushed. This session:

1. **Re-verified everything**: build ✓, typecheck/lint/format ✓, spec-045
   suite 16 passed / 3 todo ✓.
2. **Live validation run** (the remaining evidence item): 10 min coffee-shop
   sim, real LLM glm-5.3-flash via Ollama Cloud (`https://ollama.com/v1`,
   `LLM_API_KEY=$OLLAMA_API_KEY`), harness `examples/live-conv-validation.ts`
   (gitignored via `.git/info/exclude` — wraps the production
   `buildCoffeeShopEngine()` and polls `conversationManager` / pending-query /
   relationships every 10s; log `session-logs/045-live-run.log`).
   - **First live conversations ever**: 3 created (`conv-…-1..3`) — pre-fix
     this was structurally zero (openOrContribute never called). R1/R2 wiring
     confirmed live.
   - Speaker-side reciprocity accumulates live (Carol→Bob sentCount=2).
   - BUT all 3 threads closed within a tick and no pending-address line ever
     rendered. Root cause found (see below).
3. **Gap 1 — name-keyed targeting**: perception renders agents by NAME only
   (`perception-builder.ts:82`, `Agents present: Bob (…)`); the tool schema
   asks for `targetAgentId`; nothing resolves name→ID. The live LLM passed
   `"Bob"` → conversation participants keyed to a phantom with no agent state
   → the R7 co-location sweep removes it within one tick → thread closes.
   Real target never participates: no AC-2 pending-address, no AC-3
   same-thread reply, no AC-4 target-side receivedCount, and `queueMessage`
   delivers to a phantom key. **Root-cause candidate for #167's reply-rate-0.**
4. **Gap 2 — sentiment dropped**: `openai-client.ts:662` calls
   `executeTalkTo(agentId, targetAgentId, message)` — the `sentiment` arg from
   the LLM never reaches the executor, so live deltas are always the
   neutral-branch +5/+2. (Neutral/positive → +5/+2 by design per spec 033 R6;
   only negative-dominant exchanges differ, +1/+0 — so live delta variation
   additionally requires a negative-tagged turn.)
5. Both gaps are in `packages/cognition`/`packages/shared` — outside spec
   045's package boundary (`examples/assembly.ts` only). Filed as issue #173
   issue; referenced from #165 and #167. AC-1..4 left unchecked in the spec
   with a Live-validation evidence section added; AC-5/AC-6 checked (AC-6 with
   one noted deviation: the spec-018 INDEX regex uncap, commit 4c391de — the
   previous session's honest recount to 61 broke the stale bounded pattern).
6. Full suite re-verified green after the regex fix: 2,323 passed / 0 failed.

### Environment notes (session 2)

- Ollama Cloud direct API works with `LLM_BASE_URL=https://ollama.com/v1`
  + `LLM_API_KEY` + `LLM_MODEL=glm-5.3-flash` (fast, tool-calling capable).
  Model list: `curl https://ollama.com/v1/models`.
- The 120-tick conversation idle timeout does NOT fire in live runs: the
  executor's `currentTick` defaults to `Date.now()` (ms epoch) while the
  lifecycle sweep compares game ticks — the idle check is vacuously false.
  Threads persist across LLM cycles; what kills them is the R7 co-location
  sweep removing phantom participants. Worth knowing before anyone "fixes"
  the tick mismatch.
### Final state (session 2, recorded as the YAAM breadcrumb)

- PR #172 OPEN, branch `feature/165-assembly-conversation-wiring` pushed
  through `0c2cd2c`+ (live-evidence docs). CI: GitGuardian pass; no other
  checks configured on this repo.
- Follow-up issue for the two live-run blockers: **#173** (name-keyed
  targeting + dropped sentiment arg; cross-referenced #165/#167).
- Spec 045 row: 🔍 In Review in INDEX.md. AC-5/AC-6 checked; AC-1..4 open on
  #173.
- YAAM daemon (TCP 43535, JSON-RPC `search` with `{"text": …}`) indexes the
  spec + this note — verified reachable this session.

---

## Session 3 (2026-09-10, resumed) — full re-verification green; PR body refreshed

Nothing structural remained: branch up to date with origin, working tree
 clean, PR #172 OPEN/MERGEABLE (GitGuardian SUCCESS — the only CI configured
on this repo), INDEX row 045 already 🔍 In Review, YAAM final-state breadcrumb
from session 2 intact.

Re-verified from a cold checkout this session (all fresh runs):
- `pnpm build` ✅ → `pnpm typecheck` ✅ → `pnpm lint` ✅ → `pnpm format:check` ✅
  (examples resolve built `dist/`, so build-first order matters).
- `pnpm test`: **2,323 passed / 0 failed / 1 skipped** (shared 342, visualizer
  48, memory 101, cognition 883, engine 783, examples 151, cli 15) — matches
  the AC-5 evidence recorded in the spec.
- Implementation diff re-inspected: 12 added lines in `examples/assembly.ts`
  (R1 `conversationBridge: core.conversationManager` on the executor + R2
  `social.setConversationManager(core.conversationManager)`), exactly per spec
  R1–R4; spec-018 regex uncap is the only other code change (documented AC-6
  deviation).

Actions taken this session:
- **PR #172 body refreshed** — the old body predated the live-validation
  session; it now includes the live-validation summary (3 conversations,
  Carol→Bob sentCount=2), the AC status (AC-5/6 ✅, AC-1..4 open on #173 with
  the two named cognition gaps), and the #173 reference. Title unchanged.
- No code changes → no new commit needed beyond this notes commit; spec and
  INDEX untouched (statuses were already correct).

### Handoff

Work is fully done pending review/merge of PR #172. The only open thread is
**#173** (name-keyed targeting + dropped sentiment arg) — that is where
AC-1..4 live-run evidence will land, per the spec's Live-validation section.
Next session on this feature should check PR #172 review state / merge, then
flip the INDEX row 045 to ✅ Done (and verify the spec checkbox states once
#173 lands).
