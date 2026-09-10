# Implementation Notes — Spec 047 (Talk Loop Fix: Urge-Gated Urgency & Asymmetric Social Reward) — Issue #176

> Branch: `feature/176-talk-loop-urge-gating-asymmetric-reward`. PR opened against
> `main` referencing this spec + issue. YAAM daemon (`search`-only, no note-write —
> same finding as the design notes) was queried for the Architect's workspace notes
> (`feature-047`, `feature-176`, `talk_to social drive restore 10`,
> `urge reciprocity decayed directive IMPORTANT`, `conversation contribute turn
> speaker thread`); this file records what was built per the notes-directory
> convention and is discoverable via `yaam_search`.

## What was built (R → file → tests)

| Req | Implementation | Tests |
| --- | --- | --- |
| R7 | `packages/shared/src/types/social-urge.ts` — `SOCIAL_TALK_CAP = 3`, `SOCIAL_MONOLOGUE_REWARD = 2`, `SOCIAL_EXCHANGE_BONUS = 8` next to the 044 constants (doc comments cross-reference spec 047 + issue #176) | `packages/shared/tests/spec-047-talk-loop-constants.test.ts` |
| R1/R2/R3/R4 | `packages/cognition/src/pper/perception-builder.ts` — exported pure gates `isSocialUrgeDecayed`, `isSocialTalkCapped`, `allPresentUrgesDecayed`, `talkToPromotionRequested`, `NO_SOCIAL_OUTLET_LINE`; the 024 directive renders only when `!urgesAllDecayed`, else the no-outlet line; the 018 social hint is suppressed under the same gate; the 044 "You feel like talking to" line is suppressed for capped targets; `moveTalkToFirst` fires only when `talkToPromotionRequested(...) && !urgesAllDecayed` | `packages/cognition/tests/spec-047-talk-loop-urge-gating.test.ts` (17 tests) |
| R5 | `packages/cognition/src/tools/cognitive-tool-executor.ts` — `executeTalkTo` grants `{ social: SOCIAL_MONOLOGUE_REWARD }` (+2) per send instead of +10 | same cognition suite (AC-4) |
| R6 | `packages/engine/src/social/conversation-manager.ts` — optional `onExchangeRestore(agentId, conversationId, amount)` option; after a successful `contribute` by T, every other current participant S with ≥ 1 prior turn in the thread (`turnCount > 0` — survives the rolling window — or windowed turns, covering rejoined agents) and not already in the `${conversationId}:${senderId}` granted-set receives `SOCIAL_EXCHANGE_BONUS` once per (sender, conversation). `packages/engine/src/assembly.ts` wires it to `driveSystem.applyChanges(agentId, { social: SOCIAL_EXCHANGE_BONUS })` (existing AgentManager drive path — no new plumbing) | `packages/engine/tests/spec-047-exchange-restore.test.ts` (9 tests) |
| AC-1/AC-2/AC-7/AC-8 E2E | production stack (`createEngineCore` + `assembleCognitionStack`, no manual wiring) | `examples/tests/spec-047-talk-loop-urge-gating.test.ts` (5 tests) |

## Key decisions made during implementation

- **Gate parity is per-present-agent**: `allPresentUrgesDecayed` requires an assessment
  for EVERY present agent (partial coverage or `undefined` socialUrges → directive renders
  exactly as today — feature-off backward compat, spec 044/046 untouched).
- **R3 vs R4 are two separate gates**: `talkToPromotionRequested` (urge ≥ threshold AND not
  capped) is the urge-layer request; `!allPresentUrgesDecayed` is the room-level veto. Both
  must hold for `moveTalkToFirst`. (A decayed urge can still numerically exceed the surface
  threshold — reciprocity 0.54 with seed 0.9/drive 10 → urge ≈ 0.50 — hence the veto.)
- **Capped+surfaced targets** fall through to the 044 "rarely answers" line when reciprocity
  is also decayed, and render no urge line when trust/familiarity modulation keeps reciprocity
  ≥ 0.7 — either way no promotion, no approach hint (influence, not force).
- **Cognition NEVER grants the +8** (AC-4 negative test pins this): the executor always grants
  exactly +2 per send, even into an exchange thread; the +8 is exclusively the engine-side,
  thread-scoped, idempotent top-up (R6 constraint — multi-agent runs would double-count).
- **Engine grant rule** (D5 verbatim): on turn by T in conversation C, for each current
  participant S ≠ T with prior contributions and not yet granted → grant once. Rejoined
  agents (fresh participant record, `turnCount` reset) are still recognized via windowed
  turns; the granted-set makes re-contributions/leave-rejoin/multi-sender idempotent.
- **KV-cache (spec 021)**: no-outlet line and gate live in the dynamic section only; the
  stable "You can call talk_to…" capability line is untouched (AC-8 asserts this).
- **Spec-032 AC-4 updated intentionally** (`examples/tests/spec-032-drive-restoration.test.ts`):
  send +2, then the apprentice's reply into the same thread completes the +8 → total +10
  (spec 018's restoration promise preserved for real exchanges). Note: the test must place
  the apprentice (`updateState(location: 'garden')`) because no game loop runs in the test.

## Verification status

- `pnpm test` — all packages green (shared 347, visualizer 48, memory 101, cognition 940,
  engine 948, examples 172, cli 15 — incl. 26/24/141/3 `todo`s); spec-044 and spec-046
  suites pass unmodified (AC-7).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build` — clean.
- Deterministic throughout — no LLM, no scheduler changes, no drive-decay changes.

## Commits on the branch

1. `test(spec-047)` — acceptance-criteria tests written first (4 files).
2. `test(spec-047)` — low social drive in examples AC-7/AC-8.
3. `feat(spec-047)` — the implementation (R1–R7) + spec-018 +10 assertion update.
4. `test(spec-032)` — AC-4 updated for the asymmetric reward.
5. `style(spec-047)` — prettier + unused-import cleanup.
6. `docs(spec-047)` — these notes + INDEX status → In Review.
7. `docs(spec-047)` — record PR #178 in the INDEX.

## Resume-verification record (final state)

A later session resumed after the interruption and **re-verified every gate from a clean
working tree** on `feature/176-talk-loop-urge-gating-asymmetric-reward` (nothing was left
uncommitted): `pnpm typecheck` ✓, `pnpm lint` ✓, `pnpm format:check` ✓, `pnpm -r run test`
exit 0 across all 7 packages ✓ (spec-044 + spec-046 suites re-run in isolation: 30/30 ✓),
`pnpm -r run build` ✓. PR [#178](https://github.com/Redna/evol-hive/pull/178) is OPEN and
MERGEABLE with GitGuardian checks passing; body references this spec + issue #176
(`Closes #176`). `docs/specs/INDEX.md` row 047: status `🔍 In Review`, PR #178 recorded.
Spec AC checkboxes left unticked per the in-review convention of specs 044/046. No code
changes were needed on resume — the feature was already complete and green. Spec 047 is
**done pending review**; next actor: merge PR #178 (or address review comments).

## Resume-verification record #2 (second session, clean re-check)

A third session resumed and **re-verified every gate again from the clean working tree**
(nothing uncommitted; branch up to date with origin): `pnpm typecheck` ✓, `pnpm lint` ✓,
`pnpm format:check` ✓, `pnpm -r run test` exit 0 across all 7 packages ✓ (shared 27,
visualizer 9, memory 13, cognition 49, engine 62, examples 10, cli 4 test files — all
passed), `pnpm -r run build` ✓. Targeted regression re-run: shared spec-044 + spec-047
constants 33/33 ✓; cognition spec-044 + spec-046 + spec-047 suites 47/47 ✓ (AC-7 no-regression
holds). PR [#178](https://github.com/Redna/evol-hive/pull/178) OPEN, GitGuardian check
**SUCCESS**, mergeable; `mergeState: BLOCKED` is solely the required human review
(`REVIEW_REQUIRED`) — no agent action can or should clear it. INDEX.md row 047 already
`🔍 In Review` with PR #178; PR title/body reference this spec + issue #176. No code changes
were needed — feature remains complete and green. Next actor unchanged: review + merge #178.

## QA verification record — PR #178 coverage audit (issue #176)

Independent test-coverage verification of PR #178 against the spec's 8 ACs. **Verdict: PASS —
coverage complete; no missing tests; no new tests required.**

- **Gates re-run from a clean tree @ `35f7ab6`**: `pnpm -r run build` ✓ → `pnpm test` ✓ 7/7
  packages (shared 347; cognition 913 passed/1 skipped/26 todo; engine 807 passed/141 todo;
  examples 169 passed/3 todo; cli 15; visualizer + memory files green) → `pnpm typecheck` ✓,
  `pnpm lint` ✓, `pnpm format:check` ✓.
- **AC matrix (all green)**: AC-1 → examples obedient-LLM spam bound (≤ 10 talk events/pair,
  asserts >0); AC-2 → shared constants sum + engine 40→42→50 + examples E2E + updated spec-032
  AC-4; AC-3/AC-8 → cognition R1/R2 prompt suites + examples AC-8 snapshot with KV-cache
  stable-prefix assertions; AC-4 → cognition +2 precision incl. the "cognition never grants the
  +8" negative; AC-5 → cognition cap math/per-target exclusion; AC-6 → engine idempotency
  (1..N, rejoin, multi-sender, silent-participant, self-reply negatives) + examples AC-2b;
  AC-7 → full suite + targeted spec-044 (17/17), spec-046 (13/13), spec-018 (41/41).
- **36 new spec-047 tests** across 4 suites. Constraints pinned too: influence-not-force,
  thread-scoped grants, no second reciprocity computation, KV-cache dynamic-only lines.
- **Environment note**: the 4 shared test files importing the `@evol-hive/shared` package entry
  require a prior `pnpm -r run build` (vite package-entry resolution) — bootstrap detail, not a
  defect.
- **QA report posted on PR #178** (comment 5622706980); label `Status: In Review/QA` added to
  issue #176 (keeping `Status: Ready for Dev`, matching issues #160/#173 convention).
- **YAAM**: daemon confirmed search-only from this session (JSON-RPC TCP :44835; no write
  methods) — this file is the indexed record. Next actor unchanged: human review + merge #178.

## Re-verification record — second QA pass on PR #178 (post-docs-commit)

Independent re-verification of PR #178 at the **current head `2ec0390`** (one docs commit past
the first QA pass's `35f7ab6`; code identical — diff `35f7ab6..2ec0390` touches only
`docs/specs/INDEX.md` and this notes file). **Verdict: PASS — coverage confirmed complete;
no missing tests; no new tests required.**

- **Gates re-run from a clean tree @ `2ec0390`**: `pnpm -r run build` ✓ → `pnpm test` ✓ 7/7
  packages (shared 347; visualizer 48; memory 101 passed/24 todo; cognition 913 passed/
  1 skipped/26 todo; engine 807 passed/141 todo; examples 169 passed/3 todo; cli 15) →
  `pnpm typecheck` ✓, `pnpm lint` ✓, `pnpm format:check` ✓.
- **Targeted suites**: shared spec-047+044 33/33 ✓; cognition spec-047+044+018 75/75 ✓
  (spec-018 AC-26 asserts the +2 via `SOCIAL_MONOLOGUE_REWARD`); engine spec-047 9/9 ✓;
  examples spec-047+046+032 31/31 ✓ (spec-046 target-resolution suite 10/10 untouched —
  `git diff origin/main...HEAD --name-only` confirms zero spec-046 files changed).
- **AC matrix re-confirmed (all 8 green)**: AC-1 → examples obedient-LLM spam bound
  (30 iterations, ≤ 10 talk events/pair, > 0 asserted); AC-2 → shared sum test + engine
  40→42→50 + examples AC-2/AC-2b + updated spec-032 AC-4 (55→57→65); AC-3/AC-8 → cognition
  R1/R2 suites (directive absent, no-outlet line in dynamic only, "rarely answers" present,
  stable prefix unchanged) + examples AC-8 production snapshot (capability line intact,
  talk_to still in tool list — influence, not force); AC-4 → cognition +2 precision incl.
  the "cognition never grants the +8" negative + legacy-path +2; AC-5 → cap math (≥ 3,
  reply-offset), promotion exclusion, per-target hint exclusion; AC-6 → engine idempotency
  (1..N turns, leave/rejoin, 3-sender thread, self-reply + silent-participant negatives);
  AC-7 → full 7-package suite green + spec-044 (28 shared/17 cognition) + spec-046 (10
  examples) unchanged.
- **38 new spec-047 tests** across 4 suites (5 shared + 17 cognition + 9 engine + 5
  examples; plus 2 intentionally-updated legacy assertions in spec-018/spec-032).
- **One observation (non-blocking)**: the constraint "do not count a target's message in a
  *different* conversation as the exchange" has no dedicated test — it is enforced structurally
  (`grantExchangeRestores` scans only the conversation the turn landed in; the grant key is
  `${conversationId}:${senderId}`), so no cross-conversation grant is possible by construction.
  A dedicated test would be nice-to-have, not required.
- **YAAM**: daemon (JSON-RPC TCP :42439 this session) re-confirmed search-only —
  `workspace_append_note`/`workspace_initialize` hang (methods absent from the daemon's
  dispatch table); `yaam_search("feature-")` surfaces this file, not workspace notes. This
  section is the indexed QA record. QA report re-posted on PR #178 superseding the first
  (same verdict). Next actor unchanged: human review + merge #178.