# Feature: Dynamic-World Demo — Drive Restoration Affordances & Long-Run Equilibrium

## Context
- Architecture: [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (5 drives, 0–100, decay 0.1/s, primary-drive selection), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (affordance → engine effect → `driveChanges`), [§6 — PPER Loop](../architecture/06-pper-loop.md) (drive labels feed Perceive/Plan hints), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (`talk_to`/`help` social restoration)
- Related specs: [019 — Configurable Drive Decay Rate](019-configurable-drive-decay-rate.md) (decay knob), [018 — Multi-Agent Social](018-multi-agent-social.md) (`talk_to` +10 social, `help` boosts target primary drive + own social), [024 — Social Tool Invocation Fix](024-social-tool-invocation-fix.md) (LLM calls social tools directly), [030 — Dynamic Scenes](030-dynamic-scenes-living-worlds.md) (the demo scene this spec amends)
- Package: `examples` only (scene definition + handlers + sim docs). No changes to `shared`, `engine`, `cognition`, or `memory` — all required handlers already exist as builtin `HandlerPlugin`s.
- Issue: [#125 — Dynamic-world demo: no energy-restoring affordance — drives decay to zero in long runs](https://github.com/Redna/evol-hive/issues/125)

## Problem Summary

During the 12-min real-LLM validation run of `examples/dynamic-world.ts` (spec 030), the Gardener's energy decayed monotonically 99 → 28 while its thought bubble read *"Restore energy by find..."* — no affordance in the scene restores energy (or social). Long-horizon runs slide toward a degenerate state, and the LLM wastes plan cycles seeking remedies that do not exist.

Current drive economy (no positive-energy affordance anywhere):

| Affordance | Drives |
|---|---|
| plant_seeds | +12 curiosity, +4 comfort |
| water_plants | +10 curiosity, +5 comfort |
| work | +6 curiosity, **−4 energy**, −3 comfort |
| take_tool | +8 curiosity |
| build_planter | +20 curiosity, +8 comfort |

## Requirements

### Energy Restoration

- **Req 1 — Garden bench with builtin rest affordances**: Add a `garden-bench-1` furniture object to the garden room exposing `sit_outside` (builtin: comfort +15, curiosity +5, **energy +3**) and `relax` (builtin: comfort +20, **energy +5**), plus `observe`. The builtin furniture `HandlerPlugin` (`packages/engine/src/scene-loader/handler-plugins.ts`, registered via `createBuiltinPlugins()` in `dynamic-world-sim.ts`) already provides both handlers — no new handler code.
- **Req 2 — Workshop rest affordance**: Add a `stool-1` furniture object to the workshop room exposing `relax` (builtin: comfort +20, **energy +5**) and `observe`, so the workshop (the only room with energy-negative `work`) also has an energy-restoring affordance. Every room must restore energy.
- **Req 3 — Scene object consistency**: Both new objects must be registered in their room's `objectIds` and in `DYNAMIC_WORLD_SCENE.objects` per the spec-022 authoring format, so they appear in perception, the System 0 affordance index, and the visualizer without engine changes.

### Social Restoration

- **Req 4 — Social restoration via existing tools, documented**: Social drive is restorable only through agent-to-agent tools (`talk_to` → own social +10, `help` → target's primary drive + own social). This already works (spec 018/024); the Gardener is solo only for the bounded t+0 → t+60s window before the Apprentice spawns (max 6 points of social decay at 0.1/s from the default 100). The sim header comment and demo docs must document the full drive economy (decays AND restorations, incl. which room/tool restores social) so future runs and readers see the closed loops.

### Balance Validation

- **Req 5 — Equilibrium, not one-way slide**: With the new affordances, a purposeful agent must be able to keep every drive bounded away from 0: decay is 0.1/s per drive (≈1.5 points per ~15s PPER cycle), while `relax` (+5 energy) and `sit_outside` (+3 energy, +15 comfort, +5 curiosity) out-earn decay when used at a reasonable duty cycle alongside the curiosity/comfort loops (`work` −4 energy is offset by interleaved bench/stool visits).
- **Req 6 — No phantom remedies**: The Gardener's perception and plan surface must contain the actual rest affordances (`sit_outside`/`relax` on bench/stool) once the drives decay, so the LLM never plans around nonexistent remedies (the observed *"Restore energy by find..."* failure).

### Compatibility

- **Req 7 — Scene-only change, zero engine/cognition deltas**: The fix touches only `examples/dynamic-world.ts` (scene + docs) and optionally `examples/dynamic-world-sim.ts` (header docs). All existing tests pass unmodified; the `SceneDefinition` format, builtin handlers, decay rates, and other example scenes are unchanged.

## Acceptance Criteria

- [ ] **AC-1**: `DYNAMIC_WORLD_SCENE` contains `garden-bench-1` (garden) and `stool-1` (workshop), both `type: 'furniture'`, listed in their room's `objectIds`; a deterministic test asserts that every room in the scene has ≥ 1 object with an affordance whose effect applies a positive energy delta. (maps to Req 1, Req 2, Req 3)
- [ ] **AC-2**: Executing `sit_outside` on `garden-bench-1` and `relax` on `stool-1` (via the builtin furniture handlers resolved by `autoRegisterHandlers`) returns `success: true` with `driveChanges` containing positive `energy` (+3 and +5 respectively) and positive `comfort`. (maps to Req 1, Req 2)
- [ ] **AC-3**: A deterministic mock-cognition run of `dynamic-world-sim.ts` (no real LLM) exercises `sit_outside`/`relax` and shows the target agent's energy and comfort increase by the handler deltas after the Execute phase applies `driveChanges`. (maps to Req 1, Req 2, Req 5)
- [ ] **AC-4**: With a second agent co-present, a mocked `talk_to` execution raises the sender's social drive by +10 (existing spec-018 executor path through the sim's cognition stack); the sim documentation states the solo-window bound (≤ 6 social decay before the Apprentice spawns at t+60s). (maps to Req 4)
- [ ] **AC-5**: A 10-min real-LLM run (`USE_REAL_LLM=true SCENE_DURATION_MS=600000 npx tsx examples/dynamic-world-sim.ts`) shows each of the Gardener's five drives oscillating rather than monotonically decaying — min values stay bounded away from 0 (no drive pinned at 0 for the run; energy recovers after bench/stool visits). Attach the visualizer drive traces as evidence on the issue. (maps to Req 5)
- [ ] **AC-6**: Spot-checking the visualizer thought bubbles during the 10-min run shows the LLM selecting `sit_outside`/`relax` (or the curiosity/comfort loops) instead of searching for nonexistent remedies; a perception snapshot at low energy lists the bench/stool affordances. (maps to Req 6)
- [ ] **AC-7**: `pnpm -r test && pnpm typecheck && pnpm lint` pass with zero modifications to `packages/*`; the coffee-shop, morning-routine, and office-day scenes and their tests are byte-identical. (maps to Req 7)

## Constraints
- **Examples-only**: no changes to `packages/shared`, `packages/engine`, `packages/cognition`, `packages/memory`. The builtin furniture plugin already implements `relax` and `sit_outside` — reuse it; do not add parallel handlers in `createDynamicWorldHandlers()` for the same effect IDs (that would shadow/conflict with plugin registration semantics).
- **Scene authoring format unchanged** (spec 022): new objects are plain `SceneDefinition` entries — no runtime mutations needed for this fix; `SceneMutationService` is not involved.
- **Determinism**: all acceptance tests except AC-5/AC-6 (which require a real LLM and are recorded as manual/observational evidence) must pass without LLM calls.
- **No new npm dependencies.**
- **Patterns to follow**: coffee-shop's `gardenBench`/`Sofa` object definitions (`examples/coffee-shop.ts:226–256`) are the reference pattern for rest objects; keep `makeObject`/`aff` factories and handler placement in `createDynamicWorldHandlers()` consistent.
- **What NOT to do**: do not change the 0.1/s decay rate or `DEFAULT_DRIVES` (spec 019 governs decay config); do not couple energy restoration to planter state (e.g. a `rest` effect gated on `seeds_planted == 3`) — it was rejected because it hides the remedy behind an opaque counter, gives no discoverable resting place in the workshop, and adds scene-specific handler logic where a builtin already suffices; do not add a second agent at t=0 (changes the spec-030 mutation timeline the demo exists to exercise).
