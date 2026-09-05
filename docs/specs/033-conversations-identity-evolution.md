# Feature: Conversations as Perceivable Temporal Objects & Identity Evolution (self-model, dialogue threads, cross-session continuity)

> Drafted from [Issue #128](https://github.com/Redna/evol-hive/issues/128).

## Context

- Architecture: [§2 System Overview](../architecture/02-system-overview.md), [§3 Agent State Schema](../architecture/03-agent-state-schema.md), [§4 Smart Objects & Affordances](../architecture/04-smart-objects.md), [§6 PPER Loop](../architecture/06-pper-loop.md), [§8 Cognitive Tools](../architecture/08-cognitive-tools.md), [§10 Cognitive Guardrails](../architecture/10-cognitive-guardrails.md), [§11 Memory Architecture](../architecture/11-memory-architecture.md)
- Related specs: [012](012-agent-persona-system.md) (persona), [017](017-persistence-save-load-game-state.md) (persistence), [018](018-multi-agent-social.md) (social/relationships), [024](024-social-tool-invocation-fix.md) (`talk_to` invocation), [030](030-dynamic-scenes-living-worlds.md) (dynamic scenes, dormant agents), [031](031-execute-colocation-guard.md) (co-location guard)
- Package: shared, engine, cognition, memory, examples (visualizer)

Two gaps close off the core promise — agents that are *changed by their world*:

1. **Identity is frozen.** `AgentProfile` is immutable after spawn; `update_internal_state` only touches `newGoal`/`driveOverrides`. Agents accrue memories but never *become* different.
2. **Conversations are one-shot broadcasts.** `talk_to` delivers an isolated message (delivery, +10 social, relationship deltas — validated), but there is no thread, no turn-taking, no shared state, and message content evaporates after one Perceive tick.

**Design direction (agreed in the issue): conversations become first-class perceivable temporal objects — smart objects with affordances that agents join and contribute to.** This reuses the spec-022/030 stack: perception, tool offering, guardrails, spec-031 co-location, persistence, visualizer.

## Requirements

Each requirement is tagged with the acceptance criterion (AC) that verifies it.

### Scope A — Conversations as perceivable temporal objects

- **R1 — Conversation object creation.** Opening or continuing a directed exchange (`talk_to`) creates — or attaches to — a conversation smart object in the room, carrying: `id`, LLM-derived `topic`, `participants`, rolling `turns`, per-participant `sentiment` aggregates, `openedAt`, `lastActivity`. (AC-1, AC-3)
- **R2 — Lifecycle.** Conversations move through `open → active → closed`. Close happens on idle timeout or when the last participant leaves; close triggers consolidation (R5). (AC-1, AC-4, AC-5)
- **R3 — Affordances.** The conversation object exposes exactly four affordances, subject to role and co-location rules:
  - `join` — non-participant, co-located agents only;
  - `contribute` — participants only; carries the message text plus an LLM-tagged `sentiment` (`positive` / `neutral` / `negative`);
  - `leave` — participants only;
  - `observe` — non-participants see `topic` + participants (not the full turn window).
  
  `talk_to` maps to *open-or-contribute*: if the target agent shares an open conversation with the speaker, it contributes to that conversation; otherwise it opens one. (AC-1, AC-2, AC-3)
- **R4 — State schema with a bounded rolling window.** Turns carry `{ agentId, role, content, sentiment, tick }`. Participants get derived roles (`initiator` / `active contributor` / `listener`, by turn count) and per-participant sentiment aggregates. The object stores only the **last ~8 turns**; full history exists only in close-time consolidation. No unbounded growth (same bug class as Redna/yaam#124). (AC-3, AC-6)
- **R5 — Close-time consolidation.** When a conversation closes, each participant receives a structured `interaction` memory summarizing their derived role, the exchange, and the per-participant sentiment summary. (AC-4)
- **R6 — Sentiment → relationships.** Aggregated participant sentiment modulates trust/familiarity deltas on `Relationship` (spec 018): a predominantly negative exchange must not increase trust (today trust blindly gains +2 per message). Positive/neutral behavior keeps the current deltas. (AC-7)
- **R7 — Co-location integration (verify, not build).** Spec-031's co-location guard makes wandering off equivalent to leaving the conversation: an agent that is no longer in the conversation's room fails `contribute` gracefully (structured failure feedback, no crash) and is removed from `participants`. (AC-5)
- **R8 — Guardrail integration (verify, not build).** Conversation affordances flow through the existing guardrail stack: affordance masking, contextual forcing, and rate-limiting apply unchanged. (AC-2)
- **R9 — Visualizer.** The visualizer renders live conversation objects (topic, participants) with a sentiment-derived tint. (AC-10)
- **R10 — Persistence.** Conversations serialize into `DynamicWorldSnapshot` and round-trip save/load with `SAVE_FORMAT_VERSION = 3`. Closed conversations are resumable next session. (AC-9, AC-12)

### Scope B — Identity evolution & cross-session self-model

- **R11 — `identity` self-model.** The persona becomes a structured, agent-maintained record (traits, self-narrative, long-term goals) living in the memory store and injected into prompts like other memories. `AgentProfile` remains the immutable spawn seed; the *live* self-model is the memory-resident record. (AC-8)
- **R12 — `update_self_model` cognitive tool.** A slow, guarded counterpart to `update_internal_state` that proposes bounded edits to the self-model (trait drift, self-narrative edits, aspiration updates). (AC-8, AC-11)
- **R13 — Session-end identity consolidation.** On despawn/save, a guarded LLM pass reviews the session's memories + conversation threads and proposes identity deltas. **Bounded**: rate-limited, max-N changes per session, and every delta is stored as an auditable `identity_change` event. Prompt injection via `talk_to` cannot instantly rewrite identity (deltas are LLM-proposed, guarded, bounded, and audited — never direct writes from message text). (AC-8, AC-11)
- **R14 — Dormant respawn reads the evolved self-model.** `DormantAgentStore` (spec 030) snapshots are extended with the self-model, so respawned agents come back changed by their last session. (AC-9, AC-13)
- **R15 — Social influence is real.** Conversation sentiment aggregates and derived roles (R4) feed identity consolidation (R13), so agents measurably change each other through conversations. (AC-7, AC-11)

### Prerequisite (blocking, small)

- **R16 — Relationship persistence verified.** Code inspection at HEAD shows `Relationships` ride inside `AgentInternalState`, which is snapshotted in `AgentSnapshot.state` and restored by `EnginePersistence.load()` — so the issue's "relationships are not in `SaveState`" claim appears stale. Regardless, a round-trip regression test must prove trust/familiarity survive save/load **and** the dormant respawn path; any gap found is fixed within the v3 bump (R10). (AC-12)

## Acceptance Criteria

- [ ] **AC-1** (R1, R2, R3): Two co-located agents: A's `talk_to` opens a conversation object; B perceives it and can `join` / `contribute`; the conversation transitions `open → active` on B's first contribution.
- [ ] **AC-2** (R3, R8): Conversation affordances are offered only to eligible agents (co-located non-participants see `join`/`observe`; participants see `contribute`/`leave`), and existing guardrail masking/rate-limiting applies to them.
- [ ] **AC-3** (R1, R3, R4): Turns append to the rolling window with `{agentId, role, content, sentiment, tick}`; derived participant roles and per-participant sentiment aggregates update on each turn; the window never exceeds the cap.
- [ ] **AC-4** (R2, R5): Conversation close (idle timeout or empty) produces per-participant `interaction` memories including derived role and sentiment summary.
- [ ] **AC-5** (R2, R7): An agent leaving the room fails `contribute` gracefully (spec-031 guard) and exits the conversation; if it was the last participant, the conversation closes.
- [ ] **AC-6** (R4): Conversation object state stays bounded (≤ ~8 turns) across arbitrarily long sessions — no unbounded growth.
- [ ] **AC-7** (R6, R15): Sentiment shifts relationship deltas — a negative exchange produces no trust gain (and a positive/neutral one preserves current deltas).
- [ ] **AC-8** (R11, R12, R13): `update_self_model` produces auditable `identity_change` deltas; rate-limited; max-N per session; prompt injection via `talk_to` cannot instantly rewrite identity.
- [ ] **AC-9** (R10, R14): Save/load round-trips conversations, relationships, and evolved self-models (format v3); dormant respawn restores the evolved self-model.
- [ ] **AC-10** (R9): The visualizer renders live conversation objects with sentiment tint.
- [ ] **AC-11** (R12, R13, R15): Identity consolidation consumes session memories + conversation threads (sentiment/roles) and emits bounded, audited deltas.
- [ ] **AC-12** (R10, R16): A regression test proves relationship trust/familiarity survive save/load and dormant respawn; `SAVE_FORMAT_VERSION` is 3 and v1/v2 saves still load.
- [ ] **AC-13** (R14): A respawned dormant agent's prompt reflects the evolved self-model, not the spawn-time persona seed.
- [ ] **AC-14** (all): All existing tests pass; no LLM call on any deterministic path (turns append, lifecycle transitions, relationship deltas, persistence are all deterministic).

## Constraints

- **Package boundaries:** shared ← engine, shared ← memory, shared ← cognition, memory ← cognition. The conversation object type lives in `shared` (both engine and cognition need it); engine owns lifecycle/state; cognition owns LLM tagging/consolidation via existing bridge interfaces (ADR-0001 pattern — mirrors `TopologyGuard`/`AffordanceGuard`).
- **No LLM on deterministic paths.** Turn appends, lifecycle transitions, sentiment→relationship mapping, and persistence must be pure TypeScript. LLM only derives topic/sentiment at write time and consolidates at close/session end.
- **Bounded state.** Rolling window cap (~8 turns) on the object; full history only as close-time memories. No unbounded growth anywhere (Redna/yaam#124 class of bug).
- **Persistence:** plain JSON-serializable structures only (spec 017 rule: `JSON.stringify` with no replacer). Bump `SAVE_FORMAT_VERSION` 2 → 3; keep `MIN_SUPPORTED_SAVE_FORMAT_VERSION` at 1 so old saves load.
- **Reuse, don't rebuild:** conversations are `SmartObject`s — perception, classifier pruning, guardrails, spec-031 co-location, `DormantAgentStore`, and the visualizer must treat them like any other object (verify-first for the "free wins": R7–R9).
- **Strict TS:** `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` (`import type` for types), 100-char width.
- **What NOT to do:** do not make `AgentProfile` mutable (it stays the spawn seed); do not write identity deltas directly from message text; do not let conversation objects run `ObjectStateRule` state evolution; do not block the synchronous game loop on LLM responses (use `is_thinking` routing).
