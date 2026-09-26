# Feature: Context Correctness (2/N) — Reachable Offers: Stale Area Anchors and Closed Doors in the `targetArea` Enum

## Context

- Architecture: [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (`spatialMemory`), [§6 — PPER Loop](../architecture/06-pper-loop.md), [§10 — Cognitive Guardrails](../architecture/10-cognitive-guardrails.md)
- Related specs: [038 — Spatial Navigation / Fog of War](038-spatial-navigation-fog-of-war.md) (visited rooms, known doors, explored cells), [039 — Spatial Phase 2](039-spatial-phase2-targetarea-intents.md) (R1: `targetArea` is enum-bound to KNOWN areas), [030 — Dynamic Scenes](030-dynamic-scenes-living-worlds.md) (runtime topology: doors open/close, objects are removed/relocated), [064 — Executable Offers](064-context-executable-offers.md) (slice 1 of the same defect class)
- Issue: [#225](https://github.com/Redna/evol-hive/issues/225) — findings **2 and 3**; this is slice 2 of 10
- Package: `engine` (spatial memory + the `getKnownAreas` projection); `cognition` untouched unless the seam proves wrong
- Status: 📝 Drafted

## Problem Summary

Same class as spec 064, one level deeper: **the context must be executable.** Spec 039 R1 made `targetArea` enum-bound to the agent's *known* areas so the model cannot invent a destination. But "known" is memory, and memory is append-only — while spec 030 lets the world change underneath it. The result is an enum of destinations the agent cannot actually reach.

### The chain, verified

`getKnownAreas` (`packages/engine/src/agents/perception/index.ts:177-196`) builds the enum source from three things:

```ts
for (const room of mem.visitedRooms) add(room);
for (const pair of mem.knownDoors) { const [a, b] = pair.split('|'); add(a); add(b); }   // ← finding 3
for (const anchor of Object.keys(mem.observedObjects ?? {})) add(anchor)                  // ← finding 2
```

That list is what `formulatePlanToolFor(prunedAffordances, knownAreas)` enum-binds (`plan-builder.ts:103`).

**Finding 3 — a door observed open, later closed.** `knownDoors` is append-only: `navigation.ts:349-350` pushes a pair and nothing ever removes one. `isKnownRoom` (`navigation.ts:184-196`) treats a door-adjacent room as known *regardless of the door's current state*. So the room beyond a now-closed door stays in the enum. The plan step is legal, and the walk returns `'no-route'` (`navigation.ts:143/161/164/173`).

**Finding 2 — an object removed or relocated.** `observedObjects` is written at `navigation.ts:391-417` and merged at `social-manager.ts:91-119` (and `agents/perception/index.ts:134`) — never pruned. `Object.keys(observedObjects)` is folded into the area list as if each object id were a *place*, so a deleted object is offered as a destination whose `pathToObject` returns `no-route`.

### The distinction this spec turns on

**Knowledge and offer are different things, and only one of them is allowed to be stale.**

- `knownDoors` is legitimate knowledge: an agent that has seen a door *knows* the room beyond it, and closing the door does not unlearn that. Deleting the pair would be the wrong fix — it would corrupt the memory model.
- The `targetArea` enum is an **executable offer**: every value in it must be routable *this cycle*.

So the fix restricts the *offer*, not the *knowledge* — except for one case that is genuinely false memory: an anchor for an object that no longer exists or no longer lives in that room.

## Requirements

### R1 — The `targetArea` enum contains only areas reachable this cycle

- `getKnownAreas` (the enum source) MUST NOT include an area that cannot currently be routed to: specifically, an area known **only** through a currently-closed door, and not otherwise visited/anchored.
- Areas reachable through an open door, previously visited rooms, and current object anchors remain offered exactly as today (spec 039 R1/AC-1 unchanged for the reachable case).
- An empty enum (nothing reachable) MUST degrade as spec 039 already specifies — no invented destinations.

### R2 — Stale object anchors are corrected, not offered

- An anchor for an object that no longer exists in the world, or that no longer lives in the room the anchor names, MUST NOT be offered as an area, and MUST NOT render as current perception.
- The anchor MUST be corrected (pruned, or re-pointed at the object's current room when it moved) so the memory stops asserting something false.

### R3 — Knowledge is preserved

- `knownDoors` MUST NOT be deleted when a door closes: the door pair remains in memory (the agent still knows the door and both rooms).
- Door-derived areas become offered again as soon as the door is open, or once the agent has actually visited the room (which is `visitedRooms` evidence and outlives any door state).

### R4 — One reachability decision, reused

> **Seam constraint found while verifying (resolve before implementing R1).**
> `getKnownAreas` lives on the perception provider
> (`packages/engine/src/agents/perception/index.ts`), whose collaborators are
> `agentManager`, `smartObjectRegistry`, `driveSystem` and `feedbackStore` —
> **no grid, no navigation, no door state**. So R1 cannot be implemented inside
> that method as it stands: the current-door-state check has to come from the
> spatial authority (`grid.ts` / `navigation.ts`), either by injecting a
> reachability input into the provider or by computing the filtered projection
> where the grid already lives. R2 (object existence) *is* implementable here —
> `smartObjectRegistry` is available.
>
> **Seam RESOLVED (2026-09-25) — inject a narrow port from the spatial authority.**
> The code settled it rather than a preference:
>
> 1. **The spatial authority already owns the decision.** `WorldGrid.route(from, to)`
>    is documented as "BFS over the room connection graph (**open doors only**) …
>    pure function of topology + door state", and its `isConnectionOpen` is an
>    **injected predicate** supplied at `assembly.ts` from
>    `sceneManager.getConnectedRooms` — so door state is already a first-class,
>    *dynamic* input to the spatial layer. That is what makes "currently closed"
>    meaningful at all.
> 2. **Navigation already holds that grid and already answers routability**
>    publicly: `requestWalk(agentId, toRoomId): boolean` ("false = no open
>    route").
> 3. The alternative — computing the filtered projection where the grid lives —
>    would drag spec-039 knowledge assembly (`visitedRooms` + `knownDoors` +
>    `observedObjects`) into the spatial layer, duplicating knowledge logic there
>    to avoid adding one predicate.
>
> So `PerceptionDataProviderOptions` gains an optional narrow port,
> `canReachArea(agentId, areaId): boolean`, implemented by the spatial authority
> **reusing the same route the walk uses** (R4: one decision, reused — no second
> notion of "passable"). Wired in `assembly.ts`, where both objects already
> exist. Both options stay inside `engine`: a seam choice, not a boundary change.
>
> R2 (object existence) stays where it is — `smartObjectRegistry` is already
> available to the provider.

- The current-door-state check MUST reuse the existing spatial authority (the grid/navigation route or door-state lookup) rather than introducing a second, divergent notion of "passable" (`grid.ts` / `navigation.ts` own it).

### R5 — A guard for the class

- A test MUST fail if the `targetArea` enum contains an area for which the same cycle's navigation returns `'no-route'`. Asserted against both the enum and the navigation result, not against literals.

## Acceptance Criteria

- [ ] **AC-1** (R1, finding 3) — Door open → neighbour offered; door closed (same agent, knowledge retained) → neighbour **not** offered, and `knownDoors` still contains the pair.
- [ ] **AC-2** (R3) — After the door reopens, the neighbour is offered again without re-observation; a visited room stays offered even with the door closed.
- [ ] **AC-3** (R2, finding 2) — A removed object's anchor disappears from the offered areas and from perception; a relocated object's anchor points at its new room.
- [ ] **AC-4** (R1) — Reachable behaviour is unchanged: visited rooms, open-door neighbours and live anchors are all still offered (spec 039 R1 regression).
- [ ] **AC-5** (R4) — The reachability decision comes from the existing spatial authority (one source), demonstrated by a test that flips door state and observes the enum follow.
- [ ] **AC-6** (R5) — The guard exists and **fails** when a stale area is re-admitted (verified red before green).
- [ ] **AC-7** — Existing suites stay green, explicitly including spec 038/039/030 spatial and dynamic-scene suites, and the `knownAreas`/`targetArea` tests in cognition.

## Constraints

- Package boundaries: `engine` only, unless the seam proves wrong — then the spec is amended, not the boundary.
- Do NOT delete door knowledge (R3); do NOT special-case one door or one object type.
- Spec 039 R1's guarantee (the enum never contains an area the agent does not know) MUST hold: this spec narrows the enum further, never widens it.
- Spec 061's block contract and spec 021's KV-cache split MUST NOT change: `Known areas` stays a dynamic-section block.
- No performance regression on the per-cycle path: the check is per-cycle, over a small area list; reuse the existing route/door lookup rather than a new BFS per area if one is already available.
- No new dependencies.

## Test Seams

1. **`getKnownAreas`** — the projection itself, asserted as data for a given `spatialMemory` + world state (door closed/open, object removed/relocated). Primary seam for R1–R3.
2. **Navigation agreement** — the guard (R5/AC-6) builds the enum and asks the same cycle's navigation for the route, so the two cannot disagree silently.
3. **Existing spatial suites** — spec 038/039/030 behaviour is the regression net for AC-4.

## Out of Scope

The remaining #225 findings, each its own slice: the drive-hint/plan-contract contradiction (`formatPlanDriveHint`/`formatPlanChainHint` instruct a direct affordance call while `completePlan` accepts only `formulate_plan` — the #212 class), a cognitive tool executing mid-loop while `completePlan` still fails the plan, `LLMError` bypassing `failFormation`, `budgetPlanContext` truncating an instruction mid-sentence, `listConversationsInRoom` contradicting its docstring, and closed conversations remaining perceived. Also out of scope: the `checkPlanBinding` legality question and the refuted reflect-contract item.
