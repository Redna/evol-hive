# QA Notes — Spec 048 (Drive-Economy Rebalance for cc=3) — PR #179 coverage audit

> YAAM note: the daemon (raw-TCP JSON-RPC on `127.0.0.1:<.yaam/daemon.port>`,
> port 35659 this session) answers `search` (`{"text": …}` — HTTP framing is
> rejected with `Parse error`, raw newline-delimited JSON-RPC works;
> `note_write` → `Method 'note_write' not found` (-32601), same finding as the
> spec 045/046/040 notes). `yaam_search("feature-")` returned 10 hits — module
> content + issue #168 evidence, **no pre-existing feature-048 workspace
> notes**. Findings are recorded here per the notes-directory convention; this
> file is itself YAAM-indexed and discoverable via `yaam_search`.

## Scope

QA pass over PR #179 ("spec: draft spec for issue #168 — spec 048"), issue
#168. PR #179 is a **spec-only draft** (single commit `3c8f692`): the working
tree carried the pre-implementation state the spec documents — no
`ENGINE_DECAY_SCALING` anywhere, `DriveDecaySystem.update` applied the raw
`deltaSeconds` per agent (no N-scaling), no `Affordance.progresses` field in
`shared`, no chain-progress collection in the spec-034 matcher, no chain hint
lines in the perception/plan builders. Therefore **zero of AC-4..AC-7 mapped
to existing tests** at audit time (AC-1/2/3 are live-run evidence ACs — see
below). Following the repo's own precedent (spec 045/046 QA sessions), the QA
pass implemented R1–R3 per the spec and pinned every deterministic AC with
tests. #179 merged mid-audit (18:53:23Z, before the QA commits landed), so
the implementation + tests + this record ride the follow-up QA PR **#180**
(branch `feature/168-drive-economy-rebalance-spec`, commits `0709bb1` / `4399da9`).

## AC → test coverage map

| AC | Status | Evidence |
|----|--------|----------|
| AC-1 (live cc=3 run: no drive at 0 at run end) | 📋 ISSUE-EVIDENCE (live) | Not deterministically testable — requires real LLM (spec Constraints: "only AC-1/2/3 require a real LLM and are recorded as issue evidence"). Protocol: `USE_REAL_LLM=true SCENE_DURATION_MS=1800000 ENGINE_MAX_CONCURRENT_LLM=3 npx tsx examples/dynamic-world-sim.ts`, drive traces via `logState()` 15s samples attached to #168. The deterministic substrate AC-1 rests on (per-agent scaling, audit-passing restoration magnitudes) is pinned by AC-4/AC-5 tests. |
| AC-2 (hunger chain completes ≥2/3 live runs) | 📋 ISSUE-EVIDENCE (live) | Same protocol. Deterministic substrate: the chain-step visibility fix is pinned by AC-6 (matcher surfaces `plant_seeds`/`harvest` as chain hints while hunger is urgent, incl. chain-only when `eat` is gated invisible — the exact 2/3-seeds stall mechanism). |
| AC-3 (oscillation preserved in AC-1 traces) | 📋 ISSUE-EVIDENCE (live) | Same protocol. Deterministic substrate: AC-5's over-tuning guard asserts restoration deltas are above per-interval decay but BELOW 10× it (no monotone-maxing regime); AC-4's N=1 bit-identity keeps the cc=1 reference behavior untouched (spec 032 AC-5 / 034 Req 9). |
| AC-4 (decay at rate/N; rate at N=1; 'none' raw; N=1 bit-identical; spec-019 fixtures unmodified) | ✅ COVERED | `packages/engine/tests/spec-048-drive-decay-scaling.test.ts` (14 tests): 3 agents → −0.3 at rate 0.3/Δ3; N=3 loss = N=1 loss / 3 (exact); 'none' → raw rate at N=3; N=1 **bit-identical** (`toBe`/Object.is) vs a legacy twin decayed through `DriveSystemImpl.applyDecay` directly (IEEE-754: `x/1 === x` — applyDecay untouched, spec-019 contract intact); divisor tracks the LIVE count per tick (spawn/despawn mid-run — never `maxConcurrentCycles`); `defaultEngineConfig().decayScaling === 'per-agent'`; `defaultDecayScaling()` env mapping incl. invalid-value fallback; `createEngineCore` resolves the field onto the core; assembled-loop ticks honor 'none' (2 agents → raw rate) and the 'per-agent' default (2 agents → rate/2). Spec-019 suite passes **unmodified** (verified in full run). |
| AC-5 (economy audit: max restoring delta > decayRate/3 × meanCycleInterval; failing pair named) | ✅ COVERED | `examples/tests/spec-048-economy-audit.test.ts` (11 tests): bound derived deterministically — decayRate pinned to `defaultEngineConfig().driveDecayRate` = 0.1 (spec 019), cc=3 (Req 5 protocol), SCENE_DURATION_MS=1.8e6 (30-min run), expected cycles/agent = 20 (issue #168 evidence: 60–90s per-agent intervals) → meanCycleInterval = 90s → max per-interval decay ≈ 3.0; audit runs over the DECLARED `effects` of every affordance in `DYNAMIC_WORLD_SCENE` (matcher's only source of truth); failures name the (affordance, drive) pair; social audited against its documented restoration source (`talk_to` +10, spec 018 — no affordance declares social effects BY DESIGN, spec 032); ledger maxima pinned (energy 5 / hunger 25 / comfort 20 / curiosity 12 / social 0-declared); Req 4 over-tuning guard (restoration < 10× decay); sim header doc assertions (cc=3 numbers present, spec-032 AC-4 pattern). |
| AC-6 (matcher: chain hints for hunger<40; none ≥40; none for social; absent `progresses` → no hint) | ✅ COVERED | `packages/cognition/tests/spec-048-drive-chain-hints.test.ts` (14 tests): hunger 23 + eat visible → direct [eat] first, chain [plant_seeds, harvest] after (perception order, notes + attribution preserved); **chain-only match** surfaces when `eat` is gated invisible (affordances=[], chainProgress non-empty — the stall fix); no match at hunger=40 or 80; `progresses: {drive:'social'}` NEVER hints (social not hintable); `progresses` naming a non-urgent drive → no hint; legacy fixtures without `progresses` → byte-identical matches + hints (`chainProgress` absent, pre-048 shape); cap = MAX_DRIVE_HINT_AFFORDANCES in perception order; PerceptionBuilder: chain line AFTER direct line, dynamic section only (KV-cache, spec 021); chain-only match renders NO "restore it" line; PlanBuilder: imperative chain line AFTER the direct imperative, names the first (next) chain ref; unattributed refs render the spec example form verbatim; no-note refs render without parens. |
| AC-7 (`pnpm -r test && typecheck && lint`; spec-019/032/034 unmodified; coffee-shop/morning-routine untouched) | ✅ COVERED | Full run: **2,439 tests passed, 0 failed** (shared 347, engine 821, cognition 927, examples 180, memory 101, visualizer 48, cli 15); `pnpm typecheck` green (all packages); `pnpm lint` green; prettier `format:check` green on all touched files. Spec-019 (drive-decay-rate + coverage), spec-032 (drive-restoration), spec-034 (drive-affordance-hints + hunger-chain) suites pass **unmodified**. Only non-048 test edit: `packages/engine/tests/multi-agent.test.ts` ×2 — the spec-008 AC-7 decay tests pinned to `decayScaling: 'none'` (+ comment): they assert the RAW per-agent rate at N=2, which is precisely the 'none' mode under spec 048's default; intent preserved. Coffee-shop / morning-routine scenes untouched. |

## Implementation summary (R1–R3, PR #180)

- **R1** `shared`: `DecayScaling = 'per-agent' | 'none'`, `EngineConfig.decayScaling?`,
  `defaultDecayScaling()` (reads `ENGINE_DECAY_SCALING`, default `'per-agent'`,
  invalid values fall back — typos cannot silently disable scaling),
  `defaultEngineConfig()` surfaces it. `engine`: `DriveDecaySystem` gains
  `DriveDecaySystemOptions.decayScaling` and applies the effective rate by
  scaling the delta passed to the UNTOUCHED `DriveSystemImpl.applyDecay`
  (`deltaSeconds / N`, N = `getActiveAgents().length` at that tick; `x/1 === x`
  keeps N=1 bit-identical). Plumbing: `createEngineCore` resolves
  `config.decayScaling ?? 'per-agent'` onto `EngineCore.decayScaling`;
  `assembleGameLoop` passes it to the registered system — the same
  config→core→system path `sceneSchedulerConfig` uses. `examples/dynamic-world-sim.ts`
  surfaces `ENGINE_DECAY_SCALING` via `defaultDecayScaling()` exactly like its
  `ENGINE_MAX_CONCURRENT_LLM` read.
- **R2** audit test (AC-5 above) + sim header drive-economy table updated with
  the cc=3 numbers (≈3 points/interval worst case; per-drive audit results).
- **R3** `shared`: `Affordance.progresses?: { drive; note? }` (additive,
  optional — legacy fixtures unchanged). `cognition`: matcher additionally
  collects chain refs (`progresses.drive === urgent drive`, perception order,
  capped at `MAX_DRIVE_HINT_AFFORDANCES`, notes carried on refs; match emitted
  for direct OR chain refs — chain-only when the gated restorer is invisible);
  `formatPerceptionChainHint` / `formatPlanChainHint` render the secondary line
  after the direct hint (per-drive grouping, dynamic section only). Builders
  emit direct line → chain line per drive; social untouched. `examples`:
  `aff()` factory gains an optional 6th `progresses` param;
  `plant_seeds` (`note: 'harvest → eat restores hunger'`) and `harvest`
  (`note: 'eat restores hunger once a vegetable is ripe'`) declare
  `progresses: { drive: 'hunger' }`; no scene affordance declares social.

## Verification

- `pnpm test` (=`pnpm -r run test`): **2,439 passed / 0 failed** (+168 todo, 1 skipped, 3 todo-examples).
- `pnpm typecheck`: green. `pnpm lint` (eslint packages/*/src): green.
- `prettier --check` on all touched files: green.
- Note: the first full `pnpm test` run failed one pre-existing spec-027 E2E
  (`real-llm-visualizer.e2e.test.ts`) with `ERR_MODULE_NOT_FOUND:
  @evol-hive/visualizer/dist` — an unbuilt workspace in this environment, not a
  code change; `pnpm build` of memory/visualizer/cli resolved it. Subsequent
  full runs green.

## Residuals (for the reviewer / dev)

- AC-1/2/3 need the 3 × 30-min live cc=3 runs (Req 5) with `logState()` traces
  attached to issue #168 before the issue can leave In Review/QA.
- `plant_seeds` still declares no restorable `effects` (its +12 curiosity is
  handler `driveChanges` only) — deliberate: faking a hunger effect is
  explicitly rejected by the spec ("What NOT to do"); the chain declaration is
  the surfacing mechanism.
- The audit's `EXPECTED_CYCLES_PER_AGENT = 20` encodes the issue's 60–90s
  observed interval band (worst case). If a future scheduler change alters the
  cc=3 cadence, re-derive the bound from fresh traces before touching
  magnitudes (the test names any failing pair).