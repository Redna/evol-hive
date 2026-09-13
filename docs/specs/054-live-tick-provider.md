# Feature: Live Tick Provider for CognitiveToolExecutor — Fix Epoch-ms Turn/Relationship Stamps (Issue #195)

## Context
- Architecture: [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (`talk_to` execution path, relationship bookkeeping), [§6 — PPER Loop](../architecture/06-pper-loop.md) (the perceive→plan seam where freshness and pending-address ages surface)
- Related specs: [spec 018](./018-multi-agent-social.md) (Req 41 — `currentTick` constructor option), [spec 033](./033-conversations-identity-evolution.md) (R1/R3 — `openOrContribute` turn stamping, R6 — relationship deltas), [spec 044](./044-social-urge-model.md) (R2 — reciprocity counters written alongside `lastInteraction`), [spec 045](./045-assembly-conversation-wiring.md) (assembler wiring of the executor), [spec 049](./049-dialogue-completion-urge-observability-reply-window.md) (R3 — fresh-address salience, `FRESH:` marker, `PendingAddressInfo.age`)
- Package: `cognition` (executor options + call sites), `assembly` (wiring)
- Issue: #195

### The bug (live-run verified, 053 run's `[social-urge]` diagnostics)
`packages/assembly/src/assembly.ts` (~line 370) constructs `CognitiveToolExecutorImpl`
**without** `options.currentTick`, so the constructor fallback fires:

```ts
// packages/cognition/src/tools/cognitive-tool-executor.ts:97
this.currentTick = options.currentTick ?? Date.now();
```

Two defects compound:
1. **Wrong value:** epoch milliseconds (~`1.789e12`) where engine `tickNumber` belongs.
2. **Stale capture:** the value is read **once at construction** (`private readonly currentTick`)
   — even a construction-time `0` would be wrong minutes later. The executor needs a
   **live** tick source, evaluated per invocation.

Downstream damage:
- Conversation turns are stamped `tick ≈ 1.789e12` → `PendingAddressInfo.age =
  currentTick − lastTurnTick ≈ −1.789e12` (visible as `age=-1789292161245` in
  `[social-urge]` lines).
- `isPendingAddressFresh` (shared/social-urge.ts:269) is trivially always-true — a
  negative age is always `< SOCIAL_PENDING_FRESH_TICKS (3600)` — so the `FRESH:`
  promotion marker (spec 049 R3) fires on every pending address, forever.
- `Relationship.lastInteraction` (executor lines 364/372/476/518/523/580) receives
  epoch ms — every consumer comparing it to engine ticks is broken.

## Requirements
- **R1 — Live tick source:** `CognitiveToolExecutorOptions` gains an optional
  `tickProvider: () => number`. The executor reads the tick **per invocation** via
  the provider, never caching it at construction.
- **R2 — Default preserves backward compat:** when no provider is wired (unwired
  test contexts only), the executor falls back to `Date.now()` **at call time**
  (not construction time), preserving today's behavior for existing tests.
- **R3 — Every stamp site uses the live tick:** all `this.currentTick` consumers —
  the `conversationBridge.openOrContribute` turn-tick arguments (spec 033 R1/R3,
  lines ~272/~338) and the six `Relationship.lastInteraction` writes (spec 044 R2,
  lines ~364/~372/~476/~518/~523/~580) — read from the live provider.
- **R4 — Assembly wiring:** `packages/assembly` passes
  `tickProvider: () => core.gameLoop.currentTick().tickNumber` when constructing the
  executor. The value MUST be the engine **tick number** (discrete ticks, matching
  `SOCIAL_PENDING_FRESH_TICKS = 3600` and `Relationship.lastInteraction: 0` initial
  values) — **not** `simulationTime` (seconds, the reflection-loop clock at
  assembly.ts:432). The *pattern* mirrors the assembler's existing provider/clock
  style; the *unit* must be ticks.
- **R5 — Non-regression of freshness semantics:** with a wired provider, spec 049
  R3's fresh-vs-stale discrimination is restored: a pending address addressed
  within 3600 ticks is `FRESH:`, an older one renders without promotion.

## Acceptance Criteria
- [ ] **AC-1** (R1/R2): Unit test — without `tickProvider`, the executor produces a
  `Date.now()`-sourced timestamp at *call* time (a construction-time value is not
  frozen: two calls separated by time produce non-decreasing stamps; an existing
  `currentTick` option continues to work for legacy tests, spec 018 AC-25).
- [ ] **AC-2** (R1/R3): Unit test — with `tickProvider: () => 5000`, a `talk_to`
  exchange stamps the conversation turn and both sides' `Relationship.lastInteraction`
  with exactly `5000`; after the provider is (re)wired to return `6000`, the next
  exchange stamps `6000` (live read, not construction capture).
- [ ] **AC-3** (R3): Unit test — every stamp site listed in R3 uses the provider
  result; none reads `Date.now()` when a provider is wired (asserted by a provider
  returning a sentinel, e.g. `424242`, far from any plausible epoch ms).
- [ ] **AC-4** (R4): Unit/E2E test — production assembly (`useRealLLM`) constructs
  the executor with a `tickProvider` wired to the core game loop; the provider
  returns the live `tickNumber` (advances as the loop ticks, 0 before start).
- [ ] **AC-5** (R5): Test — with the wired provider, a pending address whose last
  turn is 100 ticks old yields `isPendingAddressFresh === true` and renders
  `FRESH:`-promoted (spec 049 R3); one 4000 ticks old yields `false` and renders
  without promotion; `PendingAddressInfo.age` is non-negative in both cases.
- [ ] **AC-6** (R2/R5): Regression — all existing spec-018/033/044/045/049/053 tests
  that pass explicit `currentTick` values or assert freshness behavior still pass
  unmodified (option kept as the legacy injection seam).

## Constraints
- Package boundaries: only `cognition` (executor options + call sites) and
  `assembly` (wiring). `shared`, `engine`, `memory` must NOT need changes —
  `PendingAddressInfo`, `isPendingAddressFresh`, and `SOCIAL_PENDING_FRESH_TICKS`
  are already correct (they were the observability that caught this bug).
- Patterns to follow:
  - Provider-style clocks: `clock: () => core.gameLoop.currentTick().simulationTime`
    (assembly.ts:432, reflection loop) and
    `() => gameLoop.currentTick().tickNumber` (engine/src/assembly.ts:256,
    conversation affordance handlers).
  - Optional-constructor-option pattern (`CognitiveToolExecutorOptions`) with
    backward-compatible defaults — same style as `memoryInjector`, `socialBridge`.
  - Turn ticks are keyed to `tickNumber` throughout: `ConversationManagerImpl`
    stores turn `tick`, perception reads `last.tick` and compares against
    `provider.getCurrentTick()` (also `tickNumber`).
- What NOT to do:
  - Do NOT use `simulationTime` (seconds) as the provider value — it would break
    `SOCIAL_PENDING_FRESH_TICKS` (3600 ticks ≈ 60 sim-seconds at 60 fps) and mix
    units with existing `lastInteraction: 0` initializers.
  - Do NOT remove or repurpose the legacy `currentTick?: number` option — existing
    tests inject it (spec 018 AC-25 et al.); keep it as the static seam, with
    precedence `tickProvider ?? currentTick ?? Date.now()` if both are supplied.
  - Do NOT cache the provider result across invocations — the whole point of the
    fix is live reads (the executor lives for the whole process lifetime).
  - Do NOT widen the executor's error surface — a throwing provider should surface
    like any other construction-time misconfiguration (fail fast in tests), not be
    swallowed.
