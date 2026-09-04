# Implementation Notes — Spec 030 (Dynamic Scenes / Living Worlds) — Issue #117

> Progress breadcrumbs for the developer agent session on
> `feature/030-dynamic-scenes-living-worlds`. (YAAM daemon/JSON-RPC API is not
> available in this environment — using the documented docs/notes fallback.)

## Status: COMPLETE — all tests green, PR #120 opened (review pending)

## What was built (maps to spec Reqs / ACs)

**shared** (`src/types/mutations.ts` + edits):
- `SceneMutationType`/payloads, `SceneMutationEvent {seq,tick,type,payload,source}`,
  `SceneMutationError` (rule + offendingIds + actionable message) — Req 2/3
- `SceneMutationPort` bridge (engine implements, cognition consumes) — Req 13
- `DormantAgentSnapshot`, `DynamicWorldSnapshot`, `TopologyGuard`
- `SaveState.dynamic?` (absent for static scenes → byte-identical, AC-11),
  `SAVE_FORMAT_VERSION` 1→2, `MIN_SUPPORTED_SAVE_FORMAT_VERSION=1` — Req 11
- `CognitiveToolName` + `'modify_scene'`, `GuardrailConfig.maxSceneMutationsPerCycle?`,
  `CognitiveToolExecutor.executeModifyScene?`, `PlanValidationContext` — Req 13/14

**engine** (`src/world/mutations/` + registry/scene manager/persistence/assembly):
- `SceneMutationServiceImpl` — the single funnel: propose→validate→queue→apply
  at tick boundary; append-only log + `getMutations(sinceSeq?)` (Req 1/2);
  validation rules incl. drive range, duplicate ids, orphan-free objectIds,
  zero-connection rule (Req 3); doorway state mirroring (Req 9);
  `createDoorwayEffect(objectId,'open_door'|'close_door')` handlers (Req 9)
- `SceneMutationSystem` registered FIRST in `assembleGameLoop` (Req 1)
- Registry `remove()`/`setRoom()` + movement filter for closed doors (Req 4/10)
- `SceneManagerImpl` `setConnectionOpen`/`addConnection`/`removeConnection`/
  `hasConnection`/`isPairClosed` + `TopologyGuard.isMovementBlocked` (Req 9/10);
  closed pairs remembered for reopen
- `DormantAgentStore` + despawn exports full state (Req 7); respawn from
  dormantAgentId restores drives/goal/plan/location/memories (Req 8/AC-3)
- `YaamEventLog` — despawn writes agent-scoped `UPSERT_NODE` (state summary +
  memories), respawn writes `DELETE_NODE`; JSONL replayable in fresh session
  (Req 12/AC-10); coarse-grained (design note D4)
- Persistence saves/restores `dynamic` (log + dormant), v1 loads OK (AC-7/11)
- `loadScene` deep-clones rooms/objects — SceneDefinition stays immutable;
  mutation service rebound via `setSceneManager`
- `VisualizerDataAdapter.getMutationDeltas(sinceSeq?)`; snapshot reads live
  registries per frame (Req 15/AC-6); canvas renderer is stateless redraw

**cognition**:
- `modify_scene` in `defaultCognitiveTools` with strict op-enum schema (Req 13)
- Executor: `mutationPort` + `executeModifyScene` (proposals only, Req 14b),
  per-agent-per-cycle rate limit default 1 (Req 14a/AC-9),
  `resetSceneMutationBudget` (wired via orchestrator `onCycleStart` hook)
- `GuardrailEngineImpl` optional `TopologyGuard` — blocked movement rejected
  by plan validation (§10 mechanism 3, Req 10/AC-4); execute-service passes
  `{agentId, fromRoom}`; modify_scene has cognitive-tool parity (Req 14c)
- openai-client dispatches modify_scene mid-loop like other cognitive tools

**examples**: `dynamic-world.ts` demo scene + carry/gate helpers;
`assembly.ts` wires mutationPort + TopologyGuard adapter + env-tunable budget.

## Test results (TDD: tests written first, committed failing)
- shared 266 ✓ · engine 627 ✓ (7 spec-030 files) · cognition 615 ✓
  (spec-030 file) · visualizer/memory/cli/examples ✓ — `pnpm -r run test` all green
- typecheck ✓ lint ✓ format:check ✓ build ✓
- Final state: 1722 tests passing workspace-wide; branch head 32c737e (7 commits on the PR)

## Necessary existing-test adjustments (documented for review)
- 4 system-order assertions (assembly, spec-014 ×2, spec-022): new EngineSystem
  `scene-mutations` registers first — any new system changes these lists.
- spec-017-persistence: 2 version literals (error.expected, file content) now
  track `SAVE_FORMAT_VERSION` — spec 030 Req 11 mandates the 1→2 bump.
- shared persistence-types: same 2 version literals.

## Key decisions (aligned with design notes D1–D6)
- Closed connections removed from Room.connections adjacency, pair remembered
  in SceneManager for reopen (D2 — connections stay source of truth).
- Dormancy is synchronous via `DormancyMemoryPort` adapter (app wires vector
  store); cross-session persistence via YAAM JSONL replay (Req 12).
- Load uses the derived-snapshot approach (live world + log + dormant
  restored) — the spec's "equivalent derived DynamicWorldSnapshot" alternative.
- Propose-time validation (immediate LLM feedback); queue applies at tick
  boundary deterministically.

## Remaining follow-ups (none blocking)
- Optional: compaction strategy for the YAAM log is the memory pipeline's
  existing concern (unchanged by this feature).

## QA pass (PR #120 review, session 2)

**Coverage audit** — mapped all 11 ACs to tests; two gaps found and closed:
- AC-1 integration path (agent executes a `carry` affordance → engine effect →
  mutation funnel → tick boundary) was only exercised at service level. Added
  `packages/engine/tests/spec-030-carry-integration.test.ts` (4 tests) through
  the real `PhysicsSystem.executeAffordance` + assembled loop.
- No E2E ran the fully assembled engine as one living-world flow. Added
  `packages/engine/tests/spec-030-e2e-dynamic-world.test.ts` (6 tests):
  mid-run spawn → PPER cycle ≤ 20 ticks (AC-2), visualizer snapshot + deltas
  (AC-6), closed-door topology/guard/affordances (AC-4), despawn dormancy
  (AC-3), save/load round-trip (AC-7), replay determinism (AC-8).

**Bug found & fixed by the new E2E**: `PPERScheduler.update()` crashed with
`TypeError: cannot read 'isThinking' of undefined` on the tick after a mid-run
despawn — the round-robin `rrCursor` went stale when the agent list shrank.
Fixed with a cursor clamp in `packages/engine/src/systems/pper-scheduler.ts`;
the e2e despawn test now covers the regression. Any real runtime despawn
could have hit this (AC-3's "excluded from scheduler surfaces").

**AC-11 deviation (flagged for reviewer sign-off)**: five existing test files
were modified (system-order lists ×4, save-version literals ×4 + one title).
Req 11 mandates the SAVE_FORMAT_VERSION 1→2 bump, which collides with
spec-017's hard-coded literals — Req 16's "tests pass unmodified" and Req 11
are mutually exclusive; the changes are mechanical and now track the constant.
Static-scene byte-identical save fields are covered (`spec-030-persistence`).

**Verification**: `pnpm test` 1732 passing workspace-wide (1722 + 10 new),
`pnpm typecheck` ✓, `pnpm lint` ✓, `pnpm format:check` ✓.