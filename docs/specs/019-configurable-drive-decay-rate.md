# Feature: Configurable Drive Decay Rate

## Context
- Architecture: [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (drive decay), [§6 — PPER Loop](../architecture/06-pper-loop.md) (drive decay continues during thinking), [§9 — Engine Routing](../architecture/09-engine-routing.md) (EngineConfig)
- Related specs: [005 — Game Loop Integration & Minimal Scene](005-game-loop-integration.md) (DriveDecaySystem, DriveSystemImpl, EngineConfig), [013 — Richer Prototype Scenes](013-richer-prototype-scenes.md) (example scenes with EngineConfig)
- Package: `shared` (EngineConfig type), `engine` (DriveSystemImpl, DriveDecaySystem, assembly), `examples` (scene configs)
- Issue: [#72](https://github.com/Redna/evol-hive/issues/72)

## Problem

Drive decay is hardcoded at 1.0/sec. At 60 FPS, `DriveSystemImpl.applyDecay()` subtracts `deltaSeconds` per tick, totaling 1.0/sec. Energy drops from 20 to 0 in 20 seconds. Real LLM cycles take ~10–20 seconds (perceive → plan → execute → reflect). By the time the agent plans and executes an action, its energy is already at 0. Even if the action succeeds (+20 energy), it decays back to 0 in 20 seconds — the agent can never get ahead.

A previous fix introduced a configurable decay rate of 0.1/sec, but it was lost during merge conflict resolution. The `DriveSystemImpl` was rewritten without the `decayRate` parameter.

## Design Rationale

The decay rate must be configurable because:

1. **LLM cycle latency varies by provider** — local models may respond in 2–5 seconds; remote API calls can take 15–30 seconds. A single hardcoded rate cannot accommodate both.
2. **Different scenes may want different urgency profiles** — a high-stakes survival scene might use a faster decay; a relaxed social scene might use a slower one.
3. **Testing needs deterministic, fast decay** — integration tests may want to verify drive exhaustion quickly without waiting minutes.

The default of 0.1/sec is chosen because:
- A full LLM cycle (perceive ~2s, plan ~5s, execute ~1s, reflect ~5s ≈ 13s) costs ~1.3 energy at 0.1/sec — manageable.
- At 1.0/sec the same cycle costs ~13 energy — nearly impossible to recover from when starting at 20.
- The agent should feel urgency (drives are decreasing) but not be permanently stuck at 0.

The `decayRate` is a per-engine configuration, not a per-agent or per-drive parameter. Per-drive decay rates and per-agent tuning are future concerns. This keeps the change minimal and backward-compatible.

The `DriveDecaySystem` does not need its own `decayRate` parameter — it already delegates to `DriveSystem.applyDecay()`. The `DriveSystemImpl` holds the `decayRate` and uses it inside `applyDecay()`. The `DriveDecaySystem` is constructed with the `DriveSystem` instance (as it is today), so no change to `DriveDecaySystem` is needed.

The `DriveSystem` interface (in `shared`) defines `applyDecay(state, deltaSeconds)`. The interface signature does not change — the decay rate is an implementation detail of `DriveSystemImpl`, injected via its constructor. This avoids changing the interface and all its consumers.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **Add `driveDecayRate` to `EngineConfig`** — Add an optional field `driveDecayRate?: number` to the `EngineConfig` interface in `packages/shared/src/types/engine.ts`. When omitted, the default value is `0.1`. This field represents the rate at which all drives decay per second (units: drive-points per second).

2. **Update `defaultEngineConfig()`** — The `defaultEngineConfig()` function in `packages/shared/src/types/engine.ts` must include `driveDecayRate: 0.1` in its return value so that consumers using the default config get the new rate without code changes.

### Engine Layer (`@evol-hive/engine`)

3. **`DriveSystemImpl` accepts `decayRate` constructor parameter** — The `DriveSystemImpl` class in `packages/engine/src/agents/drives/index.ts` must accept an optional `decayRate: number` as a second constructor parameter (after the existing optional `agentManager`). When omitted, it defaults to `0.1`. The value must be stored as a private readonly field.

4. **`applyDecay()` multiplies `deltaSeconds` by `decayRate`** — In `DriveSystemImpl.applyDecay()`, the decay formula must change from `current - deltaSeconds` to `current - deltaSeconds * decayRate`. The `clampDrive()` wrapping must remain to keep drives in [0, 100]. This means at 60 FPS with `decayRate = 0.1`, each tick subtracts `0.1 * (1/60) ≈ 0.00167` per drive — totaling 0.1/sec.

5. **Wire `decayRate` from `EngineConfig` in `createEngineCore()`** — The `createEngineCore()` factory in `packages/engine/src/assembly.ts` must read `config.driveDecayRate` (falling back to `0.1` when undefined) and pass it to the `DriveSystemImpl` constructor: `new DriveSystemImpl(agentManager, config.driveDecayRate ?? 0.1)`.

6. **`DriveDecaySystem` unchanged** — The `DriveDecaySystem` in `packages/engine/src/systems/drive-decay.ts` requires no changes. It delegates to `DriveSystem.applyDecay(state, deltaSeconds)`, and the decay rate is encapsulated inside `DriveSystemImpl`. No new constructor parameter is needed on `DriveDecaySystem`.

### Config Layer (`config/engine.config.ts`)

7. **Read `driveDecayRate` from environment** — The `loadEngineConfig()` function in `config/engine.config.ts` must read `process.env['ENGINE_DRIVE_DECAY_RATE']` and include it in the returned `EngineConfig` object. The fallback when unset is `0.1`. Use the same `Number(... ?? 0.1)` pattern as existing fields.

### Examples Layer (`examples/`)

8. **Update `makeConfig()` in all example scenes** — The `makeConfig()` function in `examples/minimal-scene.ts`, `examples/morning-routine.ts`, and `examples/office-day.ts` must include `driveDecayRate: 0.1` in the returned `EngineConfig` object. This makes the configurable rate explicit in all scenes.

### Tests (`packages/engine/tests/`)

9. **Unit test: `DriveSystemImpl` uses `decayRate` in `applyDecay()`** — Add a test that constructs `DriveSystemImpl` with `decayRate = 0.1`, applies `applyDecay()` with `deltaSeconds = 10` on a state with `energy: 50`, and asserts the result is `49` (50 - 10 * 0.1 = 49). Add a second test with `decayRate = 0.5` and `deltaSeconds = 10` asserting `energy: 45` (50 - 10 * 0.5 = 45).

10. **Unit test: `DriveSystemImpl` defaults `decayRate` to 0.1** — Add a test that constructs `DriveSystemImpl` without a `decayRate` parameter (only `agentManager` or no args), applies `applyDecay()` with `deltaSeconds = 10` on `energy: 50`, and asserts the result is `49`. This verifies the default.

11. **Unit test: `createEngineCore` wires `driveDecayRate` from config** — Add a test that calls `createEngineCore()` with `driveDecayRate: 0.2` in the config, then accesses `core.driveSystem` and verifies that `applyDecay()` with `deltaSeconds = 10` on `energy: 50` yields `48` (50 - 10 * 0.2 = 48). Also verify that when `driveDecayRate` is omitted from config, the default 0.1 is used.

12. **Backward compatibility: existing `drive-decay.test.ts` tests pass** — The existing test in `packages/engine/tests/drive-decay.test.ts` that asserts `100 - 10 = 90` after `deltaSeconds = 10` must be updated to account for the default decay rate of 0.1: the expected value becomes `100 - 10 * 0.1 = 99`. This is the only existing test that hardcodes the 1.0/sec assumption.

13. **Integration test: drives decay slowly enough for recovery** — Add a test that simulates a 20-second window at 60 FPS with `decayRate = 0.1`. Start an agent with `energy: 20`. After 20 seconds of pure decay (no actions), assert `energy` is approximately `18` (20 - 20 * 0.1 = 18), not `0`. This demonstrates the fix: the agent has time to act.

## Acceptance Criteria

- [ ] **AC-1**: `EngineConfig` in `packages/shared/src/types/engine.ts` includes an optional field `driveDecayRate?: number`. Existing `EngineConfig` objects without `driveDecayRate` compile without error. *(Req 1)*
- [ ] **AC-2**: `defaultEngineConfig()` returns an object with `driveDecayRate: 0.1`. *(Req 2)*
- [ ] **AC-3**: `DriveSystemImpl` accepts an optional second constructor parameter `decayRate: number`. When omitted, `applyDecay()` uses `0.1` as the rate. *(Req 3)*
- [ ] **AC-4**: `DriveSystemImpl.applyDecay()` with `decayRate = 0.1` and `deltaSeconds = 10` on `energy: 50` results in `energy: 49`. With `decayRate = 0.5` and `deltaSeconds = 10`, it results in `energy: 45`. *(Req 4, Req 9)*
- [ ] **AC-5**: `DriveSystemImpl` constructed with no `decayRate` argument uses `0.1` by default: `applyDecay()` with `deltaSeconds = 10` on `energy: 50` yields `49`. *(Req 3, Req 10)*
- [ ] **AC-6**: `createEngineCore({ ...config, driveDecayRate: 0.2 })` produces a `DriveSystemImpl` where `applyDecay()` with `deltaSeconds = 10` on `energy: 50` yields `48`. When `driveDecayRate` is omitted from the config, the default `0.1` is used (yielding `49`). *(Req 5, Req 11)*
- [ ] **AC-7**: `DriveDecaySystem` is unchanged — its constructor signature and `update()` method are identical to the current implementation. It delegates to `DriveSystem.applyDecay()` without knowledge of the decay rate. *(Req 6)*
- [ ] **AC-8**: `loadEngineConfig()` in `config/engine.config.ts` reads `ENGINE_DRIVE_DECAY_RATE` from the environment with a fallback of `0.1`. When `ENGINE_DRIVE_DECAY_RATE=0.5` is set, the returned config has `driveDecayRate: 0.5`. When unset, it has `driveDecayRate: 0.1`. *(Req 7)*
- [ ] **AC-9**: All three example scenes (`examples/minimal-scene.ts`, `examples/morning-routine.ts`, `examples/office-day.ts`) include `driveDecayRate: 0.1` in their `makeConfig()` return value. *(Req 8)*
- [ ] **AC-10**: All existing tests pass after updating the one hardcoded decay assumption in `drive-decay.test.ts` (the `deltaSeconds: 10` test now expects `99` instead of `90`). No other existing tests break. *(Req 4, Req 12)*
- [ ] **AC-11**: A test simulating 20 seconds of pure decay at `decayRate = 0.1` on `energy: 20` yields approximately `18` (not `0`), demonstrating that agents have sufficient time to complete a PPER cycle and recover. *(Req 13)*
- [ ] **AC-12**: The `DriveSystem` interface in `@evol-hive/shared` (or `@evol-hive/engine` index) is unchanged — `applyDecay(state: AgentInternalState, deltaSeconds: number)` signature remains the same. The decay rate is an implementation detail of `DriveSystemImpl`, not part of the interface. *(Req 3, Req 6)*

## Constraints

- **Minimal interface change**: The `DriveSystem` interface (`applyDecay(state, deltaSeconds)`) must not change. The decay rate is injected via `DriveSystemImpl`'s constructor, not passed as a method parameter. This avoids touching every caller of `applyDecay()`.
- **Backward compatibility**: All existing `EngineConfig` objects without `driveDecayRate` must compile and work correctly (defaulting to `0.1`). All existing `DriveSystemImpl` constructions without a `decayRate` argument must work correctly (defaulting to `0.1`).
- **No per-drive or per-agent decay rates**: This spec introduces a single global `decayRate` for all drives of all agents. Per-drive tuning (e.g., energy decays faster than curiosity) and per-agent tuning are out of scope.
- **No changes to `DriveDecaySystem`**: The `DriveDecaySystem` engine system is unchanged. It already delegates to `DriveSystem.applyDecay()`. The decay rate is encapsulated in `DriveSystemImpl`.
- **No changes to `GameLoopImpl`**: The game loop, accumulator pattern, and tick propagation are unchanged. The `deltaSeconds` passed to `DriveDecaySystem.update()` is the same as today.
- **Package boundaries** (per ADR-0001): The `EngineConfig` type lives in `@evol-hive/shared`. The `DriveSystemImpl` lives in `@evol-hive/engine`. No cross-package imports are introduced.
- **Default is 0.1, not 1.0**: The default decay rate changes from the current hardcoded `1.0` to `0.1`. This is a behavioral change — drives will decay 10x slower by default. This is intentional and is the core fix. Existing tests that assume 1.0/sec decay must be updated.
- **What NOT to do**:
  - Do not change the `DriveSystem` interface signature.
  - Do not add `decayRate` as a parameter to `applyDecay()` or `DriveDecaySystem.update()`.
  - Do not implement per-drive or per-agent decay rates.
  - Do not add a runtime hot-reload mechanism for decay rate (it's set at construction time via config).
  - Do not change the game loop, PPER scheduler, or any PPER phase logic.
  - Do not change the `clampDrive()` function or drive value range [0, 100].
  - Do not add new npm dependencies.
