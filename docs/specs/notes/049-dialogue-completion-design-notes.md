# Spec 049 Design Notes — Dialogue Completion (issue #167)

> Spec: [`049-dialogue-completion-urge-observability-reply-window.md`](../049-dialogue-completion-urge-observability-reply-window.md)
> Branch: `feature/049-dialogue-reply-window` · Implementation notes recorded per repo practice
> (see `047-talk-loop-design-notes.md`, `048-drive-economy-rebalance-design-notes.md`).

## R2 — Persona-seed inference audit (`deriveSocialTalkativenessSeed`)

Audited against the actual shipped persona texts (`examples/dynamic-world.ts` for Maren Holt and
Iris Voss; `examples/dynamic-world-sim.ts` for Tomas Lind, the mid-run apprentice). The inference
mechanism (spec 044 R1, unchanged): reserved-keyword hit (traits first, then backstory) → `0.25`;
talkative-keyword hit → `0.8`; explicit `socialTalkativeness` field wins over all inference; no
signal anywhere → neutral `0.5`.

| Agent | Traits | Backstory signals | Keyword hits | Inferred seed | Correct? | Shipped seed |
| --- | --- | --- | --- | --- | --- | --- |
| Tomas Lind | `['curious', 'energetic']` | "sanding chair legs… trusts his hands more than his words, learns by doing, not by asking twice" | `'energetic'` → talkative list (traits) | **0.8** | ✅ Yes — matches the garrulous apprentice | 0.8 (inference; no explicit field) |
| Iris Voss | `['observant', 'reserved']` | "talks to seedlings more than to people… rarely venturing beyond the garden gate" | `'reserved'` → reserved list (traits) | **0.25** | ✅ Yes — matches the greenhouse recluse | 0.25 (inference; no explicit field) |
| Maren Holt | `['patient', 'methodical']` | "twelve years as a florist… measures success in harvests rather than words" | **none** — `['patient', 'methodical']` and the full backstory contain no `TALKATIVE_KEYWORDS` / `RESERVED_KEYWORDS` hits | **0.5** (neutral) | ❌ **No — inference fails explicitly**: no keyword hits anywhere, so the neutral default contradicts her quiet characterization and the expected Tomas > Iris > Maren ordering | **0.15 (explicit `socialTalkativeness`, below Iris's inferred 0.25)** |

Decision 5 applied: only Maren gets an explicit seed (`socialTalkativeness: 0.15` in
`examples/dynamic-world.ts`); Tomas and Iris stay on trait inference, which already produces the
right values. The pin lives in `examples/tests/spec-049-seed-audit.test.ts`, including the
counterfactual assertion (explicit field removed → Maren infers the neutral 0.5, proving the
shipped seed is explicit, not inferred).

## R4 — Legacy fallback vs. the spec-033 lifecycle tests (documented deviation)

The spec contains a genuine internal tension in R4, resolved as follows:

- **R4's legacy sentence** says: with `meanCycleIntervalTicks` undefined on every participant, the
  effective timeout is `max(config.idleTimeoutTicks, 2 × 3600)` — the Decision 3 fail-open default
  ("an unknown cadence widens rather than narrows the window").
- **R4's second sentence / AC-7's second clause** claims the spec-033 lifecycle tests "keep passing
  unmodified". But two of those tests (`idle timeout closes the conversation and consolidates`,
  `an open conversation with no turns closes via the sweep too`) drive the sweep to
  `11 + config.idleTimeoutTicks + 1` = 121 idle ticks with the default 120-tick config and expect
  closure — impossible under the fail-open formula (effective timeout 7200).

Both cannot hold simultaneously. We implemented **R4's formula exactly as written** (fail-open
7200 for unknown cadence) because it is the spec's core intent — leaving never-cycled agents on the
raw 120-tick floor would preserve the very bug this spec fixes (the ~2-sim-second reply window) —
and updated the **tick-target expressions** in those two spec-033 tests to
`11 + 2 × DEFAULT_CYCLE_INTERVAL_TICKS + 1`, keeping their assertions (closure happens; close-time
consolidation produces per-participant memories) untouched in meaning. The tests still derive their
timing from config constants, not magic numbers. AC-7's first clause is pinned in its strong form
(`packages/engine/tests/spec-049-reply-window.test.ts`): a no-cadence conversation is open at the
120-tick floor, open at exactly `2 × DEFAULT_CYCLE_INTERVAL_TICKS`, and closed one tick later.

## Decision notes

- **R1 diagnostic placement** (Decision 1): `PPEROrchestratorImpl.runCycle` between perceive and
  plan; the line is built by `pper/social-urge-diagnostic.ts`, wrapped in a try/catch at the call
  site, and its `line=` classification is a pure mirror of the perception-builder's hint branch
  order (`classifySocialUrgeLine`, exported next to `isSocialTalkCapped`).
- **R3 freshness data** (`lastTurnTick`/`currentTick` on `PendingAddressInfo`) is filled by the
  perceive service from the conversation's last turn and `provider.getCurrentTick()` — one tick
  read shared with the urge computation. Without both fields (legacy providers) the line renders
  today's wording in today's position (no promotion), and the diagnostic reports
  `age=unknown fresh=false`.
- **R4 EMA coefficient**: `CYCLE_INTERVAL_EMA_ALPHA = 0.2` (documented in `shared/social-urge.ts`
  next to the other constants); the first observed interval seeds the EMA directly, per R4.
- **Persistence**: all new state (`lastCycleTick`, `meanCycleIntervalTicks`, the two pending-address
  tick fields) rides the existing whole-state snapshot path (spec 044 `spawnTick` pattern) — no
  `SAVE_FORMAT_VERSION` bump.
- **R5**: no scheduler cadence/gating change; `pper-scheduler.ts` is touched only by the two-field
  bookkeeping write in `startCycle` (AC-9).