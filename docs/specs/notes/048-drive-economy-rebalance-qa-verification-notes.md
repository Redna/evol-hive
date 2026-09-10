# QA Verification Notes — Spec 048 (PR #180 follow-up coverage audit)

> YAAM note: recorded here per the notes-directory convention (daemon
> `note_write` → `Method 'note_write' not found` (-32601), same finding as the
> spec 045/046/040/048 notes; raw newline-delimited JSON-RPC `search` on
> `127.0.0.1:<.yaam/daemon.port>` works). `yaam_search("feature-")` returned
> 10 hits — all spec-035 feature-extractor module content, **no pre-existing
> feature-048 workspace notes**; `yaam_search("048 drive economy")` returned
> 9 module hits only. This file is itself YAAM-indexed and discoverable via
> `yaam_search`.

## Scope

Independent QA verification of PR #180 (QA coverage for issue #168 / spec 048,
follow-up to #179). Steps executed: PR body + full diff read; spec
`docs/specs/048-drive-economy-rebalance-cc3.md` acceptance criteria mapped to
tests; YAAM workspace-note search; gates re-run; **coverage gaps closed with
new integration/E2E tests**; QA report posted on the PR; issue #168 labeled
`Status: In Review/QA`.

## AC → test coverage map (verified)

| AC | Status | Evidence |
|----|--------|----------|
| AC-1 (live cc=3 run: no drive at 0) | 📋 ISSUE-EVIDENCE (live) | Spec Constraints: only AC-1/2/3 need a real LLM. Protocol: `USE_REAL_LLM=true SCENE_DURATION_MS=1800000 ENGINE_MAX_CONCURRENT_LLM=3 npx tsx examples/dynamic-world-sim.ts`, traces → #168. Deterministic substrate pinned by AC-4/AC-5. |
| AC-2 (chain completes ≥2/3 runs) | 📋 ISSUE-EVIDENCE (live) | Same protocol. Deterministic substrate: AC-6 (incl. the new E2E). |
| AC-3 (oscillation preserved) | 📋 ISSUE-EVIDENCE (live) | Deterministic substrate: AC-5 over-tuning guard (< 10× decay); AC-4 N=1 bit-identity keeps cc=1 reference untouched. |
| AC-4 (decay at rate/N) | ✅ COVERED (gap closed) | `packages/engine/tests/spec-048-drive-decay-scaling.test.ts` — 15 tests (was 14). **Gap found & closed**: loop-level plumbing was verified only at N=2 while AC-4's headline arithmetic is 3 agents → added the N=3 assembled-loop test (per-agent default: each agent loses 0.1×3/3 = 0.1 over 3 sim-seconds → 99.9). |
| AC-5 (economy audit) | ✅ COVERED | `examples/tests/spec-048-economy-audit.test.ts` (11 tests): bound 0.1/3 × 90s ≈ 3, named failing pairs, ledger maxima, Req 4 over-tuning guard, scene declarations, sim header docs. Note: `meanCycleInterval` is derived from the Req-5 protocol duration (1.8e6 ms) and the issue-evidence 60–90s interval band (20 cycles/agent), documented in the module docblock — the scene's scheduler config does not determine cycle cadence (LLM latency does), so the derivation is issue-evidence-based by design (residual noted in the PR's QA notes). |
| AC-6 (chain hints) | ✅ COVERED (gap closed) | Unit: `packages/cognition/tests/spec-048-drive-chain-hints.test.ts` (16 tests, synthetic affordances). **Gap found & closed**: nothing drove the REAL scene through the REAL engine gating + matcher + builders → new `examples/tests/spec-048-chain-hints-e2e.test.ts` (9 tests): real `wireSimCore()` + real declarative-condition gating (`eat` behind `vegetables >= 1`, `harvest` behind `seeds_planted >= 3`) + real fog gate + real `PerceptionServiceImpl.perceive()` + real matcher + real Perception/Plan builders. Pins chain-only surfacing, mid-chain second ref, direct-before-chain ranking, threshold, and the spec-016 masking interplay (planless agent → no hints; stored plan → hints render). Also pins the sim's actual `makeConfig()` wiring (`decayScaling: defaultDecayScaling()`), which was previously only doc-regex-checked. |
| AC-7 (gates) | ✅ PASS | `pnpm test`: **2,449 passed / 0 failed** (shared 347, engine 822, cognition 927, examples 189, memory 101, visualizer 48, cli 15; +1 skipped, todo as before). `pnpm typecheck`: green. `pnpm lint`: green. `prettier --check`: green on touched files. Spec-019/032/034 suites pass unmodified (`git status` clean for them); coffee-shop/morning-routine untouched. |

## Gaps found and closed (this QA pass)

1. **AC-4 loop-level N=3**: assembled-loop plumbing was exercised at N=2 only;
   added the 3-agent loop test mirroring AC-4a's arithmetic through a real
   `assembleGameLoop` tick stream.
2. **AC-6 real-scene E2E**: the unit suite uses synthetic copies of the
   planter affordances; the examples suite pins scene declarations statically.
   Neither covered the production path (registry gating → fog → matcher →
   builders). The new E2E suite drives `DYNAMIC_WORLD_SCENE` through the
   production `PerceptionServiceImpl` + builders with a pass-through classifier
   (spec-046 pattern) — deterministic, no LLM.
3. **Req 1 sim wiring**: `dynamic-world-sim.ts` `makeConfig()` passing
   `decayScaling: defaultDecayScaling()` was only covered by doc-header regex
   assertions; pinned at source level (makeConfig is not exported).

## Environment note

Engine/shared/cognition/etc. vitest runs resolve workspace deps via built
`dist` (no source aliases, unlike examples) — `pnpm build` is required before
`pnpm test` in a fresh checkout (same as recorded in the PR's QA notes for the
spec-027 E2E).

## Residuals (unchanged from the PR's QA notes)

- AC-1/2/3 require the 3 × 30-min live cc=3 runs with `logState()` traces
  attached to issue #168 before the issue can leave `Status: In Review/QA`.