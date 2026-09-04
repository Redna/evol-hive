# Feature: Execute-Time Co-Location Guard & Stale Plan Re-Validation (Issue #121)

## Context

- Architecture: [§4 — Smart Objects](../architecture/04-smart-objects.md) (affordance dispatch), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Execute = deterministic engine, action feedback loop §9.2), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (mechanism 3: plan validation → reflection tick)
- Related specs: [003 — Execute Phase](003-execute-phase.md) (affordance resolution & execution), [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (plan validation, `deviationRejected`), [028 — Compound Action Execution](028-compound-action-execution.md) (compound sub-step path), [030 — Dynamic Scenes / Living Worlds](030-dynamic-scenes-living-worlds.md) (Req 2 `MoveObject`, Req 10 topology-aware validation — the mutation source that makes plans go stale)
- Package: shared, engine, cognition
- Origin: [#121](https://github.com/Redna/evol-hive/issues/121) — during the dynamic-world long-horizon run, an agent executed a plan step whose target object had been relocated by a `move_object` mutation **after** plan formation. The affordance succeeded, so `taken_by: gardener-1` was set on an object in a different room. Dynamic scenes make mid-plan world mutation the common case; nothing re-validates embodied reachability between plan formation and execution.

### Root-cause analysis (codebase, verified)

All affordance execution funnels through `PhysicsSystemImpl.executeAffordance`
(`packages/engine/src/physics/index.ts`). It resolves the object by ID, checks
preconditions, and invokes the handler — it never compares the object's current
`roomId` with the executing agent's `state.location`. `ExecuteServiceImpl`
(`packages/cognition/src/pper/execute-service.ts`) resolves affordances
room-scoped via `resolveAffordance(roomId, affordanceId)`, so perception-time
validity holds at execute time only if the world did not change. Spec-030
mutations (`move_object`, `set_connection_state`) change the world between plan
formation and execution; the Execute phase (and plan validation, which today
only guards movement through closed connections per spec 030 Req 10) does not
re-check object reachability. This spec mirrors the spec 030 Req 10 treatment:
a hard execute-time guarantee plus plan-time stale-step detection (§10
mechanism 3).

## Requirements

### A. Execute-time co-location guard (engine — required)

- **Req 1** — `PhysicsSystemImpl.executeAffordance` must, before invoking the registered handler, verify that the target object's current `roomId` equals the executing agent's location. The agent's location must be resolved at execution time from the live agent state (inject an agent-location resolver into `PhysicsSystemImpl`, wired in `assembly.ts`; physics must not read cached or perception-time location). On mismatch, return `AffordanceResult { success: false, failureReason }` without invoking the handler and without any state mutation.
- **Req 2** — The co-location `failureReason` must be actionable and deterministic: it names the object's `name` and ID and the room the object is now in, in the form `"The <name> (<objectId>) is no longer here — it moved to the <roomId>."` (mirrors the graceful failure style of spec 003 Req 7/8 so the Reflect phase can adapt).
- **Req 3** — The guard applies to every execution path that funnels through `PhysicsSystemImpl.executeAffordance`: plain affordances, and each sub-step of compound actions (spec 028). A mid-compound `move_object` of the compound's owning object (or of a sub-step target) must abort the compound at that sub-step with the co-location failureReason, following spec 028 Req 6/7 abort semantics (no further sub-steps, no merged drive changes, plan step not advanced).
- **Req 4** — A co-location failure must flow into the action feedback loop (§9.2), never be silently swallowed: `ExecuteServiceImpl` must treat it exactly like any handler failure — `setSystemFeedback(agentId, failureReason)`, `setThinking(agentId, false)`, return `ExecuteResult { success: false, error: failureReason, planComplete: false }`, and **not** advance the step (the step-skip path for *unresolvable* affordances must not be reachable for co-location failures). The compound-abort path likewise sets system feedback with the compound-aware abort message.

### B. Plan-time stale-step validation (cognition + engine — recommended layer of the issue's fix)

- **Req 5** — Extend the guardrail context (§10 mechanism 3, following the `TopologyGuard` pattern from spec 030 Req 10): add an optional `affordanceGuard` to `PlanValidationContext` (type in `@evol-hive/shared`), implemented by the engine and wired in assembly, exposing `isAffordanceAvailableInRoom(affordanceId: string, roomId: string): boolean` (backed by `SmartObjectRegistry.getByRoom`).
- **Req 6** — `GuardrailEngineImpl.validateAction` must, for physical (non-cognitive) actions, reject the step when `affordanceGuard` is provided and reports the step's target affordance is no longer available in the agent's current room. The rejection reason must state the affordance and that the plan is stale (e.g. `"The '<affordanceId>' target is no longer in '<fromRoom>'. The plan is stale — reflect and choose a different action."`), producing `deviationRejected: true` → reflection tick → early re-planning. Cognitive tools and movement actions are unaffected (movement topology stays governed by the spec 030 Req 10 `TopologyGuard`).
- **Req 7** — The plan-time check must be advisory-grade: it may only reject (block execution and force reflection). It must not mutate plans, advance steps, or clear state — re-planning remains the Reflect/orchestrator's job (spec 003 Req 25).

### C. Regression guarantees

- **Req 8** — Mutation/registry consistency: after a `move_object` mutation, `SmartObjectRegistry.getByRoom(fromRoom)` must exclude the object, `getByRoom(toRoomId)` must include it, and `object.roomId` must equal `toRoomId` (the execute-time guard is authoritative even if any room-cache path goes stale; this AC locks the existing spec 030 Req 2 behavior).
- **Req 9** — Topology parity regression: closing a connection mid-plan must still cause plan validation to reject the blocked movement step per spec 030 Req 10 (guard against regressing that behavior while adding the affordance guard).

## Acceptance Criteria

*(Each AC maps to one or more requirements; each requirement has at least one AC.)*

- [ ] **AC-1** (Req 1, 2): Given an agent located in `garden` and a smart object `toolbox-1` whose current `roomId` is `workshop`, `physics.executeAffordance('toolbox-1', 'take_tool', 'gardener-1')` returns `{ success: false, failureReason: "The Toolbox (toolbox-1) is no longer here — it moved to the workshop." }`, and the registered `take_tool` handler is never invoked.
- [ ] **AC-2** (Req 1, 7): On co-location failure, the object's state is unchanged (no `taken_by` written), no `AffordanceResult.newState` is applied, and no drive changes occur — `AgentInternalState.drives` and `SmartObject.state` are identical before and after the call.
- [ ] **AC-3** (Req 4): Executing an affordance whose object has moved to another room fails with an actionable failureReason naming the object and its new room, sets system feedback to that reason (readable via `getSystemFeedback` on the next Perceive tick), returns `ExecuteResult { success: false, planComplete: false }` with `stepSkipped` unset, and does not advance the plan step.
- [ ] **AC-4** (Req 3): Given a compound action whose sub-step target object is moved to another room mid-compound, execution aborts at that sub-step: system feedback names the compound action, the sub-step index, and the co-location failureReason; remaining sub-steps are not attempted; accumulated drive changes are not applied; the plan step is not advanced. *(Req 3, 4)*
- [ ] **AC-5** (Req 4): The failure reaches the Reflect/next-plan context: after the failed execution, the agent's next perception tick includes the system feedback string, and `isThinking` is `false` (agent not frozen, §9.1).
- [ ] **AC-6** (Req 5, 6): Given an active plan step `take_tool` and a `move_object` mutation relocating `toolbox-1` out of the agent's room, `guardrail.validateAction('take_tool', plan, { agentId, fromRoom: 'garden', affordanceGuard })` returns `{ valid: false }` with a reason containing `'take_tool'` and `'garden'`; `ExecuteServiceImpl.execute` then returns `ExecuteResult { success: false, deviationRejected: true }` and sets system feedback.
- [ ] **AC-7** (Req 6): When the target affordance IS still available in the agent's room, `validateAction` does not reject on the affordance-guard dimension (existing plan-alignment behavior unchanged).
- [ ] **AC-8** (Req 6): Cognitive tools (e.g. `formulate_plan`) and movement actions (`go_to_<room>`) are never rejected by the new affordance guard; movement gating remains exclusively `TopologyGuard`/spec 030 Req 10 behavior.
- [ ] **AC-9** (Req 7): `validateAction` does not call `PlanManager.clearPlan`, `createPlan`, or `advanceStep`; rejection only produces a validation result that Execute turns into a reflection tick.
- [ ] **AC-10** (Req 8): After `sceneMutations.apply({ type: 'move_object', payload: { objectId: 'toolbox-1', toRoomId: 'workshop' } })`: `smartRegistry.getByRoom('garden')` excludes `toolbox-1`, `getByRoom('workshop')` includes it, and `smartRegistry.get('toolbox-1').roomId === 'workshop'`.
- [ ] **AC-11** (Req 9): Regression test — close the garden↔workshop connection mid-plan; plan validation rejects the `go_to_workshop` step per spec 030 Req 10 (unchanged behavior, now locked by test alongside the affordance guard).
- [ ] **AC-12** (Req 1, 3): End-to-end regression reproducing issue #121: plan `take_tool` in garden → `move_object` toolbox-1 to workshop at t+Δ → execute → graceful `{ success: false }` failure with co-location failureReason; the object chip never shows `taken_by: gardener-1`.
- [ ] **AC-13** (Req 1): The co-location check runs even when the object is resolved through a non-room-scoped path (direct `executeAffordance(objectId, …)` calls): the check compares live `object.roomId` vs live agent location, not the resolution source.
- [ ] **AC-14** (Req 1–6): No LLM call is introduced on any new code path; all new behavior is deterministic engine/guardrail logic.

## Constraints

- **Package boundaries (ADR-0001)** — the co-location check lives in `engine` (`PhysicsSystemImpl`, wired in `assembly.ts`); the affordance guard type lives in `shared`; `GuardrailEngineImpl` (cognition) consumes it only via the shared interface. No engine ↔ cognition imports. `shared` stays dependency-free.
- **Determinism** — the guard must be pure live-state comparison: no randomness, no LLM, no caching of location or `roomId` across ticks (spec 003 Req 23).
- **Patterns to follow** — mirror the `TopologyGuard` interface + engine implementation + assembly wiring pattern introduced by spec 030 Req 10 (`packages/shared/src/types/mutations.ts`, `packages/engine/src/world/scenes/index.ts`, `packages/cognition/src/guardrails/index.ts`). Failure message style follows spec 003 graceful-failure feedback (§9.2 action feedback loop).
- **Performance** — the check is O(1) per execution (one registry lookup + one agent-state read); it must not add per-tick cost (execution is event-driven, not tick-driven).
- **What NOT to do** — do not "fix" this by making `resolveAffordance` search all rooms; do not clear or rewrite the agent's plan on failure (re-planning belongs to Reflect); do not skip or advance the step on co-location failure; do not special-case movement affordances by exempting them from the guard — doorway objects live in the agent's room, so the universal check is safe; do not modify the `move_object` semantics of spec 030.
