# Feature: Social Urge Model — Influence, Not Force (User-Directed Talk Inclination)

> Issue: [#160](https://github.com/Redna/evol-hive/issues/160) — "Social reflex: being addressed should
> mark the target and force their next cycle (companion to #158)". The original title proposed a
> *forced* next cycle on being addressed; the body **supersedes that trigger design**: an agent deciding
> not to talk is valid behavior — personality, not failure. We model the **urge to talk** and the
> *likelihood* of responding — seeded initially from the persona, learned over time from reciprocity.
> No forced cycles, no triggers, no scheduler changes. The LLM keeps the decision, including staying
> quiet. Live-run context (from #158): 24 `talk_to` exchanges across 3 agents, every one a single-turn
> greeting, zero replies — the v1 deterministic urge model makes reply behavior both measurable and
> persona-differentiated.

## Context
- Architecture: [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentProfile, AgentInternalState.relationships), [§6 — PPER Loop](../architecture/06-pper-loop.md) (perceive-phase context construction, dynamic section), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (`talk_to` tool list), [§5 — Fast-Path Classifier & Trainable Heads](../architecture/05-fast-path-classifier.md) (future trained head may take over the reciprocity factor)
- Related specs: [012 — Agent Persona System](012-agent-persona-system.md) (persona seed source: traits/backstory), [033 — Conversations as Perceivable Temporal Objects](033-conversations-identity-evolution.md) (trust/familiarity modulation, open-or-contribute path, `ConversationBridge`), [034 — Drive→Affordance Hints](034-drive-affordance-hints-hunger-chain.md) (drive-urgency pattern; matcher itself excludes `social` by design), [035 — System 1 Trainable Heads](035-system1-trainable-heads.md) (the reciprocity factor is deterministic v1; a trained head can take over later), [043 — Conversation Perception Bridge](043-conversation-perception-bridge.md) (pending-address surface — 📝 Drafted, not yet implemented; see Decision 4)
- Package: `shared` (urge types + pure urge/persona-seed computation), `engine` (reciprocity counter plumbing, pending-address bridge method, `spawnTick`), `cognition` (perception-builder urge rendering, tool-list ranking shift, counter updates in `executeTalkTo`)
- Issue: [#160](https://github.com/Redna/evol-hive/issues/160)

### The model (deterministic v1)

```
urge(target) = personaSeed × socialDriveFactor × noveltyFactor(target) × reciprocityFactor(target)
```

All factors are pure deterministic functions of existing state — no LLM calls, no randomness, no
scheduler involvement. urge ∈ [0, 1] per (agent, target) pair. It renders as perception hint lines and
shifts the `talk_to` tool's ranking in the per-agent tool list; the LLM decides — including ignoring it.

1. **Persona seed** — derived at spawn from profile traits/backstory (spec 012): "reserved" (Iris) → low
   base; "energetic" (Tomas) → high. An explicit optional `socialTalkativeness` field on `AgentProfile`
   overrides trait inference when present.
2. **Social drive factor** — a low `social` drive value (0 = most urgent on the 0–100 scale) raises the
   urge. Note: the spec 034 matcher *excludes* `social` by design (the spec-018/024 social-hint system
   owns it), so we reuse its **urgency-threshold pattern**, not its matcher output (Decision 2).
3. **Novelty factor** — an agent new to the scene, or with few interactions with that target, feels a
   higher urge to approach them ("agent is new to the city").
4. **Reciprocity factor (learned, per target)** — per-relationship counters: messages sent vs replies
   received. Greet 3× with no reply → the urge toward *that target* decays ("learned they don't like to
   talk"); replies raise it. Spec 033's trust/familiarity modulate the factor. Deterministic counters
   for v1; a trained System 1 head can take over later (spec 035).
5. **Pending-address marker** — when a `talk_to` addressed the agent and their reply is still owed, the
   target's perception carries an INFORMATION line ("Iris addressed you, awaiting response: '…'") —
   no trigger, no forced cycle.
6. **Surfacing** — the urge renders as a perception hint ("you feel like talking to Iris" /
   "Maren rarely answers — maybe let her be") and shifts `talk_to`'s position in the rendered tool
   list. The LLM decides — including staying quiet.

## Design Decisions

**Decision 1 — The urge computation is a pure, deterministic function living in `shared`.** It consumes
only plain data (persona seed, drive value, per-pair counters, trust/familiarity) and returns a number
plus factor breakdown. No package can own it exclusively: `engine` computes counters, `cognition`
renders — both import the same formula from `shared` (ADR-0001: shared is the dependency sink). A pure
function is directly unit-testable (AC-2's decay test needs no engine or LLM). This also leaves the
door open for spec 035: a trained head later replaces the reciprocity factor behind the same signature.

**Decision 2 — Social-drive factor reuses spec 034's *pattern*, not its matcher.** The issue says
"reuse the spec 034 matcher's drive→talk_to affinity", but `matchDrivesToAffordances` deliberately
excludes the `social` drive (spec 034: the spec-018/024 social-hint system owns it) and matches only
object affordances — `talk_to` is a cognitive tool, not an affordance. We therefore implement the
social-drive factor inside the urge function using the same `DRIVE_URGENCY_THRESHOLD`-style semantics
(low drive value → high urgency → higher urge), and document the deviation here rather than
repurposing machinery that was explicitly scoped away from social.

**Decision 3 — Reciprocity counters are optional fields on `Relationship`.** `sentCount` /
`receivedCount` ride the existing per-pair relationship map (`AgentInternalState.relationships`), whose
save/load and dormant-respawn persistence was regression-proven in spec 033 (R16). A separate counter
store would need its own persistence story. Optional fields keep v1/v2 saves loading unchanged.
Updating both sides happens in the existing `executeTalkTo` path (speaker's `sentCount`++, target's
`receivedCount`++), next to where trust/familiarity deltas are already applied — no new write path.

**Decision 4 — Pending-address does not block on spec 043's full perception-view bridge.** Spec 043 is
drafted but unimplemented; its per-agent conversation snapshot method does not exist yet. We add a
minimal, independently useful query to `ConversationBridge` — `getConversationsAwaitingAgentReply(agentId)`
(open/active conversations where the agent participates and another participant made the last turn) —
implemented as a pure engine-side scan of the conversation map. When spec 043 lands, it consumes the
same method for its "Active conversations" section; until then the pending-address line works standalone.

**Decision 5 — "Matcher ranking shift" = deterministic tool-list ordering, no new machinery.** The
per-agent tool list is already assembled per tick by the perception-builder. When `urge(target) ≥
URGE_SURFACE_THRESHOLD` for a present target, `talk_to` is moved to the front of the tool list (stable
order otherwise). This is the cheapest deterministic way to shift the LLM's attention without adding a
new ranking subsystem or touching tool schemas.

**Decision 6 — Novelty is dual-source and optional-field based.** "New to the scene" derives from a new
optional `AgentInternalState.spawnTick` (set by `AgentManager` at spawn; `undefined` for legacy saves →
scene-novelty factor neutral 1.0). "Few interactions with that target" derives from the Decision 3
counters (total exchanges). `noveltyFactor = max(sceneNovelty, pairNovelty)` — either source alone can
raise the urge.

## Requirements

- **R1 — Persona seed with explicit override.** `AgentProfile.socialTalkativeness?: number` (0–1) on the
  persona (spec 012 field family, optional for backward compat). When absent, a pure trait-inference
  function derives the seed from traits and backstory keywords ("reserved" → low base, "energetic" →
  high; explicit field wins). The seed derivation is deterministic and unit-testable without an engine.
  (AC-1, AC-6)

- **R2 — Reciprocity counters per relationship.** `Relationship` gains optional `sentCount` and
  `receivedCount`. On every `talk_to` execution (spec 033 open-or-contribute path), the speaker's
  relationship toward the target gets `sentCount++` and the target's relationship toward the speaker
  gets `receivedCount++`. The reciprocity factor decays the urge toward unresponsive targets (greetings
  sent ≫ replies received) and raises it toward responsive ones; trust/familiarity (spec 033) modulate
  it. (AC-2, AC-7)

- **R3 — Urge computation (pure, deterministic).** A pure function in `shared` combining the four
  factors of the model above — persona seed × social-drive factor × novelty factor × reciprocity
  factor — returning the urge (0–1) and a factor breakdown for tests and debugging. No LLM calls, no
  clock dependence beyond passed-in tick values, no engine or cognition imports. (AC-2, AC-6, AC-8)

- **R4 — Perception surface.** (a) **Pending-address line**: an agent who owes a reply sees an
  INFORMATION line in the dynamic perception section naming the addressee and quoting the actual
  message (via the Decision 4 `ConversationBridge` query). (b) **Urge hint lines**: high urge toward a
  present agent renders "you feel like talking to <name>"; a decayed urge renders "«name» rarely
  answers — maybe let her be". (c) **Ranking shift**: with urge above the surface threshold toward a
  present agent, `talk_to` is ordered first in that agent's rendered tool list. All three are
  per-agent dynamic state → **dynamic section only** (spec 021 KV-cache rules). (AC-3, AC-8, AC-9)

- **R5 — No scheduler/trigger/recorder changes.** The PPER scheduler, idle-tick suppression (spec 040),
  outcome labeling (spec 041), and conversation lifecycle (spec 033: 120-tick timeout, rolling window,
  close-time consolidation) are untouched. Being addressed never forces a cycle; the LLM keeps the
  decision, including staying silent. (AC-5, AC-10)

## Acceptance Criteria

- [ ] **AC-1** (R1): In a live validation run (built `dist/` — run `pnpm build` first, spec 037
  Evidence), Tomas (persona seed inferred "energetic") issues `talk_to` at a higher rate than Iris
  ("reserved"); per-agent talk_to counts are computed from `events.jsonl`.
- [ ] **AC-2** (R2, R3): Unit test on the pure urge function: after N=3 unreplied greetings
  (`sentCount=3, receivedCount=0`), the reciprocity factor decays the urge toward that target below its
  value at `sentCount=1, receivedCount=0`; a reply (`receivedCount≥1`) restores/raises the factor.
- [ ] **AC-3** (R4a): Unit test: after A `talk_to`s co-located B, B's next assembled perception contains
  the pending-address line quoting A's actual message text ("addressed you, awaiting response").
- [ ] **AC-4** (R1, R2, R3): Live validation run (60 min, ≥3 agents): population-wide reply rate > 0
  (currently 0 across 5 runs — see #158), and per-agent reply/talk rates diverge consistently with the
  persona seed ordering.
- [ ] **AC-5** (R5): Full suite green; no source changes under `packages/engine/src/systems/`
  (`pper-scheduler.ts` untouched) and no changes to spec 033 lifecycle tests.
- [ ] **AC-6** (R1, R3): Unit test on persona-seed derivation: trait "reserved" yields a lower seed than
  "energetic"; an explicit `socialTalkativeness` overrides trait inference; unknown traits yield the
  neutral default.
- [ ] **AC-7** (R2): Unit test: executing `talk_to` (A→B) increments A's `sentCount` toward B and B's
  `receivedCount` toward A exactly once per exchange, alongside the existing trust/familiarity delta.
- [ ] **AC-8** (R3, R4b): Unit test: high urge toward a present agent renders the "you feel like
  talking to <name>" line in the dynamic section (never in stable lines); a decayed urge renders the
  "rarely answers" line instead.
- [ ] **AC-9** (R4c): Unit test on the built tool payload: with urge above threshold toward a present
  agent, `talk_to` appears first in the rendered tool list; below threshold, canonical order is
  unchanged.
- [ ] **AC-10** (R5): A regression test asserts that a pending-address marker alone does not enqueue a
  forced cycle — the target's next-cycle behavior is unchanged from spec 040 idle-tick semantics
  (suppression of wait-only ticks still applies).

## Constraints
- **Package boundaries (ADR-0001):** `shared` (urge types + pure computation + `AgentProfile`/
  `Relationship` field additions) ← `engine` (counter plumbing via `executeTalkTo`'s relationship
  update path is in cognition — see below, pending-address bridge method in `ConversationManagerImpl`,
  `spawnTick` in `AgentManager`) and ← `cognition` (perception-builder rendering, tool ordering,
  counter updates). No new cross-package edges; `shared` stays dependency-free.
- **Determinism:** the urge path performs zero LLM calls and zero async work — pure formatting and
  arithmetic, same standard as the spec 034 matcher. All values derive from state that already exists
  in `AgentInternalState` / `ConversationObject`.
- **KV-cache discipline (spec 021):** pending-address lines, urge hints, and the ranking shift are
  per-agent, per-tick dynamic state — dynamic section (and per-agent tool list) only. They must never
  enter `stableLines`.
- **Persistence:** all new state is optional fields on existing snapshotted structures
  (`AgentInternalState.relationships`, `spawnTick`) so v1/v2 saves keep loading; `SAVE_FORMAT_VERSION`
  bumps only if the implementer finds a field that cannot ride the existing snapshot path (document if
  so).
- **Future head (spec 035):** the reciprocity factor's function signature must be replaceable by a
  trained head (same inputs → same output type). Do not inline the factor arithmetic where a head
  could not later intercept it.
- **What NOT to do:** no forced cycles, no triggers, no scheduler/recorder changes (R5); no new
  primary social tool (spec 033 Decision 2 stands); no LLM calls on the urge path; no stable-section
  placement of urge state; no changes to `AgentProfile` mutability (it stays the spawn seed); do not
  reuse `matchDrivesToAffordances` for the social drive (Decision 2); no edits to `dist/`; never
  block the synchronous game loop (use `is_thinking` routing).
