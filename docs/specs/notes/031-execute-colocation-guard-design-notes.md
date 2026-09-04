# Design Notes — Spec 031 (Execute-Time Co-Location Guard) — Issue #121

> Note: recorded here because the YAAM daemon/JSON-RPC API became unresponsive
> in this environment (yaam-engine pegged at ~110% CPU / 75% MEM ingesting the
> 565 MB `events.jsonl`; RPC calls `upsert_node`/`query` time out). Workspace
> `feature-031-execute-colocation-guard` WAS successfully initialized before the
> daemon saturated. These are the design decisions that belong in that
> workspace's scratchpad — re-append to YAAM if the daemon recovers.

## D1 — Guard at the physics choke point, not in cognition (Req 1)
ALL affordance execution (plain + compound sub-steps per spec 028) funnels
through `PhysicsSystemImpl.executeAffordance`
(`packages/engine/src/physics/index.ts`). The co-location check goes there.
WHY: the reported bug shows the resolution source cannot be trusted — defense
in depth requires the check at the single point where a handler actually runs,
even for direct `executeAffordance(objectId, …)` calls (AC-13). Agent location
is read **live** via an injected resolver (wired in `assembly.ts`) because a
cached/perception-time location is exactly what went stale.

## D2 — Graceful failure, never a silent skip (Req 2/4)
`ExecuteServiceImpl` already has the right failure plumbing: `setSystemFeedback`
→ next Perceive tick (§9.2 action feedback loop → Reflect context),
`setThinking(false)` (§9.1 unfreeze), `success:false`, no step advance. The bug
report's silent success — and the existing silent step-skip path for
unresolvable affordances — are both wrong for a co-location failure: an object
that MOVED is world knowledge the agent must reflect on. The spec pins the
step-skip path as unreachable for this case. The `failureReason` names the
object and its new room so the LLM can plan "go to workshop" next.

## D3 — Plan-time layer mirrors TopologyGuard (Req 5/6)
Spec 030 Req 10 already validates movement through closed connections via an
engine-implemented guard injected into `PlanValidationContext`. Object
relocation gets the same shape: optional
`affordanceGuard.isAffordanceAvailableInRoom(affordanceId, roomId)` backed by
`SmartObjectRegistry.getByRoom`. Rejection yields `deviationRejected: true` →
forced reflection tick → early re-planning. WHY optional + advisory-only: keeps
`GuardrailEngineImpl` backwards-compatible (spec 016 config surface unchanged)
and respects spec 003 Req 25 (Execute never mutates plans — re-planning belongs
to Reflect).

## D4 — Movement affordances are NOT exempted
Doorway objects (`go_to_*`) live in the agent's current room, so a universal
`object.roomId === agent.location` check is safe for them; movement topology
stays governed exclusively by `TopologyGuard` (spec 030 Req 10, locked by
regression AC-11). Cognitive tools bypass the physical dimension of
`validateAction` entirely. WHY: special-casing would reopen exactly the class
of hole we are closing.

## D5 — Root-cause verification in code
`ExecuteServiceImpl` resolves room-scoped (`resolveAffordance(roomId,
affordanceId)`), and `move_object` mutations correctly update registry + room
references (`scene-mutation-service.ts`: `setRoom` + reference swap +
`invalidateRoom`). Yet the long-horizon run succeeded on a stale plan — so the
guarantee must not depend on which resolution path ran or on cache freshness.
Spec 031 therefore pairs (a) an authoritative live-state check in physics with
(b) plan-time staleness detection, and adds AC-10 locking mutation/registry
consistency as a regression net.

---

## Implementation record (spec 031 COMPLETE — 2025 session, PR #123)

> YAAM daemon still unresponsive at close (engine pegged on events.jsonl
> ingest; RPC silent). Recorded here per the re-append protocol above.

**Branch** `feature/031-execute-colocation-guard` → **PR #123** (issue #121).
Status: all ACs implemented; `pnpm test` green (all 7 packages), typecheck /
lint / format:check / build clean. INDEX.md → 🔍 In Review.

**What was built (by requirement):**
- Req 1/2 — `PhysicsSystemImpl` co-location guard after object resolution:
  live `object.roomId` vs live agent location via injected
  `AgentLocationResolver` (`(agentId) => agentManager.getState(agentId)?.location`,
  wired in `packages/engine/src/assembly.ts`); inert when unwired
  (back-compat). Exact failureReason per Req 2. No handler, no mutation (AC-1/2/13).
- Req 3 — compound sub-steps inherit the guard (all funnel through physics);
  `ExecuteServiceImpl.executeCompoundAction` aborts with compound-aware
  co-location message via new `resolveAffordanceAnywhere` lookup when a
  mid-compound move strands a sub-step (AC-4).
- Req 4 — plain path: when room-scoped resolution fails, global lookup
  distinguishes "moved" (co-location failure → feedback loop, no skip, no
  advance) from "nowhere" (skip path preserved). `resolveAffordanceAnywhere?`
  added as OPTIONAL `ExecuteDataProvider` method (spec-028 optional-method
  pattern); engine bridge implements it over `SmartObjectRegistry.getAll()`.
- Req 5 — `AffordanceGuard` bridge interface in shared (next to
  `TopologyGuard`); engine implements on `SmartObjectRegistryImpl`
  (`isAffordanceAvailableInRoom` via `getByRoom`); wired in
  `examples/assembly.ts`; carried in `PlanValidationContext.affordanceGuard`
  (context, not constructor — per AC-6 call shape).
- Req 6/7 — `GuardrailEngineImpl.validateAction` rejects stale physical steps
  after the topology check; `go_to_*` explicitly skipped (AC-8); reason
  template per spec; zero plan mutation (AC-9).
- Wiring — `PPEROrchestratorOptions.affordanceGuard` → `ExecuteServiceImpl`
  options → validateAction context; `examples/assembly.ts` adapter reads live
  `core.smartObjectRegistry`.

**Test layout (written first):** engine `tests/spec-031-colocation-guard.test.ts`
(10), cognition `tests/spec-031-colocation-guard.test.ts` (17), examples
`tests/spec-031-colocation-guard.e2e.test.ts` (5 — real bridges + real
mutation funnel + real GuardrailEngineImpl; no LLM). All 14 ACs covered.

**Gotchas for future sessions:**
- Fresh checkout must `pnpm build` before `pnpm test` (tests import built
  `@evol-hive/shared` / `@evol-hive/cognition` dist).
- `packages/engine/tests/richer-scenes.test.ts` `execute()` helper now walks
  the agent to the object's room before direct physics calls — the guard made
  cross-room handler tests fail (correctly).
- The e2e test imports `AffordanceHandler` from `@evol-hive/engine` (not shared).
