# Feature: Social Reflex — Pending-Address Marker: Being Addressed Marks the Target and Forces Their Next Cycle

> Issue: [#160](https://github.com/Redna/evol-hive/issues/160) — "Being addressed should mark the
> target and force their next cycle (companion to #158)." Spec 043 bridges conversation state into
> perception, but even with the bridge a reply requires the target to *independently choose*
> `talk_to` in their next cycle — dialogue robustness would depend on the LLM happening to
> prioritize it. Live evidence across 5 runs: reply rate 0. This spec makes being spoken to a
> **mechanical claim on the target**: a pending-address marker that guarantees the address shows up
> in perception (freshness), forces the target's next cycle (a soft System 1 trigger), and decays
> with the conversation lifecycle.
>
> **Dependency:** spec 043 ([#158](https://github.com/Redna/evol-hive/issues/158)) must land first —
> its perception bridge provides the display surface this spec guarantees content for. As of this
> draft, spec 043 is 📝 Drafted (spec doc merged via PR #159; implementation not landed).

## Context
- Architecture: [§6 PPER Loop & Environmental Awareness](../architecture/06-pper-loop.md) (perceive-phase context construction, cycle scheduling), [§10 Cognitive Guardrails](../architecture/10-cognitive-guardrails.md) (System 1 gating, plan validation), [§2 System Overview](../architecture/02-system-overview.md) (System 1 / System 2 split)
- Related specs: [043 — Conversation Perception Bridge](043-conversation-perception-bridge.md) (perception display surface, per-turn events, state-aware `talk_to` — **prerequisite**), [033 — Conversations as Perceivable Temporal Objects](033-conversations-identity-evolution.md) (ConversationManager lifecycle, open-or-contribute, co-location sweeps), [035 — System 1 Trainable Heads](035-system1-trainable-heads.md) (hard-trigger flags, gate-before-cycle, belt-and-braces forcing), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (stable-prefix discipline)
- Package: `shared` (participant marker type + bridge method), `engine` (marker bookkeeping, trigger query, scheduler priority lane, events), `cognition` (address-line rendering)

## Requirements

- **R1 — Pending-address marker.** `ConversationManagerImpl.openOrContribute` marks every *other*
  participant of the conversation with `addressedBy: { agentId, conversationId, tick }` when a turn
  lands (agentId = the speaker). The marker lives on `ConversationParticipant` in `shared` (optional
  field — absent = not addressed), so it rides the existing export/restore persistence unchanged.
  Re-contributions re-stamp the marker with a fresh `tick` (freshness). (AC-1)

- **R2 — Perception surface with a guaranteed address line.** The pending-address marker is carried
  into spec 043's per-agent conversation perception snapshot, and the perception-builder renders a
  dedicated address line in the "Active conversations" section: *"Iris addressed you: 'Hello
  Iris…' — the conversation is open; respond with `talk_to`"* — speaker name, actual last-turn
  text, and the conversation topic. The marker **guarantees presence + freshness**: even when the
  rolling-window rendering (spec 043 R1) already shows the turn, an unacknowledged marker always
  yields the address line. Dynamic section only (spec 021). (AC-1, AC-2)

- **R3 — Soft System 1 trigger: forced, prioritized next cycle.** Being addressed acts as a *soft*
  trigger — like drive-threshold crossings, NOT a hard alarm:
  - **Cycle guarantee:** the target's next scheduler pass fires their cycle — the scheduler never
    idles an agent carrying an unacknowledged pending-address marker for a live conversation. The
    gate is still consulted and the outcome still recorded (no learning-data hole); the trigger
    only guarantees the *cycle runs*, never *what the cycle does* — the LLM still plans freely and
    may fold the reply into other work. (AC-2)
  - **Priority lane:** the target's cycle starts on their next scheduler pass *without waiting on
    the round-robin cursor* — addressed agents are scanned ahead of the cursor, within
    `maxConcurrentCycles` capacity (a slot-starved addressed agent is first claim on the next free
    slot). (AC-2)
  - **Implementation boundary:** this is a separate soft-trigger query (e.g.
    `hasPendingAddress(agentId)` on the trigger-source port or a narrow scheduler-facing port) —
    `HardTriggerFlags`, `hasHardTrigger`, the gate head, and spec 035's gating tests are NOT
    modified. A "hard alarm" (bypassing the gate/plan to directly execute a reply) is explicitly
    rejected. (AC-2, AC-6)

- **R4 — Reply continuity (no new thread).** The marker + address line steer the target toward
  contributing via `talk_to` to the *same* conversation; spec 033's deterministic open-or-contribute
  resolution already guarantees `talk_to` between co-participants extends the existing thread
  (`turnCount ≥ 2`, status `open → active`). This spec changes nothing in that path — the unit
  tests assert the end-to-end behavior the marker makes reachable. (AC-3)

- **R5 — Marker clearing & decay.** The marker clears when:
  1. the addressed agent contributes to *that* conversation (their reply acknowledges the address) —
     the primary path; or
  2. the conversation closes (idle timeout, last participant left/despawned); or
  3. the marker decays stale with the conversation lifecycle: when the addresser is removed from
     the conversation (leave / co-location sweep / despawn), or when the addressed agent leaves
     the conversation. (AC-4)

- **R6 — Marker as event (measurability).** Address and acknowledge events hit the engine's run
  event stream (`events.jsonl`): one `conversation_addressed` event per newly-marked participant
  per turn (speaker, addressee, conversation, tick) and one `conversation_acknowledged` event when
  a marker is cleared by contribution (agent, conversation, tick). This extends spec 043 R4's
  per-turn events so reply rate (acknowledged ÷ addressed) is computable post-hoc. (AC-5)

- **R7 — No regression.** Spec 033 lifecycle/bridge/persistence/QA tests and spec 043's tests pass
  unmodified; the System 1 gate's hard-trigger semantics (flags, forcing, gating tests) are
  untouched; the scheduler's round-robin fairness for non-addressed agents is unchanged. (AC-6)

## Acceptance Criteria

- [ ] **AC-1** (R1, R2): In a unit test, after A calls `talk_to` to co-located B, B's
  `ConversationParticipant` record carries `addressedBy = { agentId: A, conversationId, tick }`;
  B's next assembled perception includes the address line with A's actual message text and the
  speaker name ("Iris addressed you: '…' — respond with `talk_to`").
- [ ] **AC-2** (R2, R3): In a scheduler test (mock orchestrator, `maxConcurrentCycles = 1`, other
  agents cycling): B carries an unacknowledged marker and `p(react) = 0` with no other hard
  triggers — B's cycle still starts on the next scheduler pass (gate consulted, outcome recorded),
  ahead of the round-robin cursor; the built perceive payload includes the address line. The plan
  includes a reply step to A (asserted via the payload's dynamic-section address line + state-aware
  `talk_to` description).
- [ ] **AC-3** (R4): B's reply via `talk_to` extends the SAME conversation: turnCount ≥ 2, no new
  conversation object created, status transitions `open → active` (spec 033 lifecycle tests
  unchanged and green).
- [ ] **AC-4** (R5): Marker cleared after B's reply (unit test). Stale decay: closing the
  conversation (idle timeout or last-participant leave) or removing the addresser from the
  conversation clears the marker (unit tests on each path).
- [ ] **AC-5** (R6): Live validation run (60 min, ≥3 agents, built `dist/`): reply rate > 0 (was 0
  across 5 runs); ≥3 conversations with ≥2 turns; `conversation_addressed` /
  `conversation_acknowledged` events present in `events.jsonl` and sufficient to compute the
  reply rate post-hoc.
- [ ] **AC-6** (R7): Full suite green; every spec 033 and spec 043 test passes unmodified; spec
  035's hard-trigger flag set, `hasHardTrigger`, and gate tests unchanged (grep-level assertion:
  no new `HardTriggerFlags` field).

## Constraints
- **Package boundaries:** `shared` (optional `addressedBy` field on `ConversationParticipant`,
  soft-trigger port addition) ← `engine` (marker bookkeeping in ConversationManager, scheduler
  priority lane, events) and ← `cognition` (address-line rendering in the perception-builder). No
  new cross-package edges; no import cycles; `shared` stays dependency-free.
- **Bridge pattern (ADR-0001):** engine implements, cognition consumes. The marker query reaches
  the scheduler through a narrow port (same shape as `System1TriggerSourcePort`), never by exposing
  the ConversationManager.
- **KV-cache discipline (spec 021):** the address line is per-agent, per-tick dynamic state —
  dynamic section only, never `stableLines`.
- **Determinism:** marker set/clear/decay and the scheduler priority lane are pure TypeScript — no
  LLM anywhere on these paths (spec 033 AC-14 discipline).
- **Soft-trigger strength:** the trigger guarantees a *cycle*, never an *action*. No forced plan
  step, no direct tool execution, no guardrail bypass — plan validation (§10) applies to the
  reply as to any action. The LLM may legitimately fold the reply into other work in the forced
  cycle.
- **What NOT to do:** do not add a `HardTriggerFlags` field or touch the gate head/weights (spec
  035 boundary); do not change conversation lifecycle semantics beyond marker bookkeeping; do not
  let the priority lane starve round-robin fairness for non-addressed agents (addressed agents
  still consume `maxConcurrentCycles` slots); do not render the address line for non-participants
  (spec 043 R2 privacy boundary holds); no edits to `dist/`.
