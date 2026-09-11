# Spec 052 — Greenhouse Drive Restoration Diagnostics: Implementation Notes

> Feature branch: `feature/052-greenhouse-drive-restoration-diagnostics` · PR [#190](https://github.com/Redna/evol-hive/pull/190) · Issue [#183](https://github.com/Redna/evol-hive/issues/183)
> Session breadcrumb — updated as work progresses. Deterministic ACs (1–4, 8) closed in the TDD commits
> (`df5849d` failing tests first → `7f63469` implementation → `02681a1` config pins → `ea563c3` format).
> This session's remaining scope: the live-run ACs **AC-5 / AC-6 / AC-7** (Req 5 protocol).

## Environment note (why this session could run the live validation)

The spec's Req 5 protocol assumes a local Ollama endpoint
(`USE_REAL_LLM=true SCENE_DURATION_MS=1800000 npx tsx examples/dynamic-world-sim.ts`).
This session has no local Ollama, but the harness exposes `OLLAMA_API_KEY` for **Ollama Cloud**
(OpenAI-compatible `https://ollama.com/v1` — verified HTTP 200 on `/v1/models`). The
`OpenAICompatibleLLMClient` (spec 006) already takes `LLM_BASE_URL` + `LLM_API_KEY` (Bearer),
so the run was redirected to cloud with no code changes:

```
USE_REAL_LLM=true \
LLM_BASE_URL=https://ollama.com/v1 LLM_API_KEY=$OLLAMA_API_KEY LLM_MODEL=gemma4:31b \
SCENE_DURATION_MS=1800000 ENGINE_MAX_CONCURRENT_LLM=3 \
npx tsx examples/dynamic-world-sim.ts
```

Embeddings stay the in-repo mock (`USE_REAL_EMBEDDINGS` unset — no ONNX artifact in this
environment); classifier pruning behavior under the mock embedder is deterministic and matches
what the deterministic AC-1 tests pin. `gemma4:31b` is the model the sim header recommends for
this scene; it appears in the cloud catalog and smoke-validated tool-calling cleanly.

## Smoke validation (before the 30-min run)

2-min smoke (`SCENE_DURATION_MS=120000`), 2026-09-11T19:54Z:
- 123 `[drive-hint]` lines, 27 `[state]` samples, ~269K tokens, clean exit, zero transport errors.
- Final sample: **no drive at 0 anywhere** — gardener e=64 h=61 s=67 co=97 cu=97; iris e=51 h=41
  s=54 co=51 cu=46; apprentice e=41 h=36 s=53 co=46 cu=56.
- Greenhouse restorers visible in enum at urgency (`afterPrune=12 afterMask=12`, `prunedAway=[]`).

## 30-min validation run (Req 5 protocol)

- Started 2026-09-11T19:58:08Z, log `/tmp/run052/full.log` (evidence excerpts to be committed).
- Early cycles confirm: apprentice-1 (greenhouse) at hunger=40 sees `rest_among_seedlings`,
  `eat_herbs`, `pick_herbs` in the post-prune enum and chose `eat_herbs` — the R2 exemption is
  live (`prunedAway=[]`); `[drive-hint]`/`[wait-guard]` lines are the AC-6/AC-7 instruments.

## Results

_(to be filled when the run completes — final `logState()` sample, `[drive-hint]` diagnosis table,
`[wait-guard]` rejection counts, AC-5/6/7 verdicts)_

## Breadcrumbs for the next session

- Tests/typecheck/lint/build verified green this session before the run (pnpm -r test: all suites
  pass; `pnpm typecheck`, `pnpm lint`, `pnpm build` clean).
- INDEX.md already marks spec 052 `🔍 In Review` with PRs #189/#190 (commit `04a56e3`).
- PR #190 is OPEN, MERGEABLE, only GitGuardian CI (pass); review approval pending.
- Remaining after the live run: attach evidence to #183, refresh PR body AC-5/6/7 statuses,
  commit these notes.

## QA verification record — PR #190 coverage audit (issue #183, commit `3dcd25d`)

Independent test-coverage verification of PR #190 against the spec's 8 ACs. **Verdict: PASS —
deterministic ACs (1–4, 8) fully covered and green; AC-5/6/7 remain live-run-pending by design
(Req 5), now with a green deterministic proxy rehearsing them in CI.**

- **Gates re-run from a clean tree @ `3dcd25d`**: `pnpm test` ✓ 8/8 suites (shared 362;
  visualizer 48; memory 101; cognition 998 passed/1 skipped/26 todo; engine 840 passed/141 todo;
  assembly 66; examples 214 passed/3 todo; cli 15 — 2644 passed) → `pnpm typecheck` ✓,
  `pnpm lint` ✓, `pnpm format:check` ✓, `pnpm build` ✓. Bootstrap note: fresh checkouts need
  `pnpm build` (or `pnpm --filter @evol-hive/shared build`) first — vite package-entry resolution.
- **The PR's HEAD at review start (`1c90346`) was TDD-RED**: the "RED — live-run findings" commit
  pinned two behaviors with failing tests and no implementation, so `pnpm test` did NOT pass at
  the reviewed HEAD (the PR body's AC-8 ✅ predates that commit). QA implemented both findings:
  1. **Occupied-room fog override** (`packages/engine/src/agents/perception/index.ts`): the room
     an agent physically occupies is self-evidently known — occupancy overrides the
     unexplored-room gate in `getVisibleObjectsInRoom`/`getVisibleAffordancesInRoom` (the
     `go_to_*` teleport path moves agents without recording the fog visit → `inRoom=0 … enum=[]
     … chosen=[wait]` forever, the #183 headline symptom through a new path).
  2. **Seed-shelf handlers** (`createDynamicWorldHandlers`): `pick_herbs` (+8 curiosity),
     `eat_herbs` (+20 hunger) — stateless, matching the declared effects exactly.
- **QA-found gap beyond the RED pins**: `repot_seedlings` (+12 curiosity/+5 comfort) and
  `rest_among_seedlings` (+15 comfort/+4 energy) were equally handlerless — `rest_among_seedlings`
  is the greenhouse's ONLY in-room energy restorer (spec-032 invariant "every room must restore
  energy"). Implemented both, pinned in the extended spec-032 AC-2b block (4 tests).
- **Integration/E2E gap closed**: no suite exercised the mechanisms THROUGH the production stack.
  New `examples/tests/spec-052-greenhouse-restoration-loop.test.ts` (3 tests): perceive→plan→
  execute→reflect over the real scene with the real classifier + real `GuardrailEngineImpl` +
  real handlers + the #183 fog condition — all-wait plan rejected before `storePlan`
  (`[wait-guard]` names hunger + `eat_herbs`; `[drive-hint] chosen=[none]`), restorer executed
  next cycle (hunger 8 → 28), no greenhouse drive at 0 (AC-5 proxy), `waitSuppression:false`
  inert end-to-end, energy loop closes via `rest_among_seedlings` (39/65).
- **Format**: prettier violations in `spec-039-spatial-phase2.test.ts` fixed (format:check was
  red at HEAD).
- **AC matrix**: AC-1 ✅ restoration-exemption suite (12); AC-2 ✅ wait-guard suite (15: pure
  guard + PlanServiceImpl integration); AC-3 ✅ drive-hint-diagnostic suite (5); AC-4 ✅
  greenhouse-scene suite (5); AC-5/6/7 ⏳ live (Req 5) + ✅ E2E proxy; AC-8 ✅ all gates +
  spec-032/034/048/049 suites green unmodified except the allowed additive config pins.
- **Issue #183 labels**: `Status: Ready for Dev` → `Status: In Review/QA` (single-status
  convention); QA report posted on PR #190.
- **Remaining before merge**: the 30-min cc=3 live run (AC-5/6/7 evidence → #183; the smoke run
  above already shows the restorers in the enum at urgency with `prunedAway=[]`).