# Feature: Social Address Reflex — Being Addressed Marks the Target and Forces Their Next Cycle

> Issue: [#160](https://github.com/Redna/evol-hive/issues/160) — "Social reflex: being addressed
> should mark the target and force their next cycle (companion to #158)". Spec 043 (#158) bridges
> conversation state into perception, but even with the bridge a reply requires the target to
> *independently choose* `talk_to` in their next cycle — dialogue robustness would depend on the LLM
> happening to prioritize it. Live evidence across 5 runs: reply rate 0.

## Context
- Architecture: [§6 PPER Loop & Environmental Awareness](../architecture/06-pper-loop.md) (perceive-phase context, System 1 trigger semantics), [§8 Cognitive Tools](../architecture/08-cognitive-tools.md), [§10 Cognitive Guardrails](../architecture/10-cognitive-guardrails.md)
- Related specs: [043 — Conversation Perception Bridge](043-conversation-perception-bridge.md) (provides the perception display surface — **this spec depends on 043 landing first**), [033 — Conversations as Perceivable Temporal Objects](033-conversations-identity-evolution.md) (`ConversationManager.openOrContribute`, lifecycle, idle timeout), [035 — System 1 Trainable Heads](035-system1-trainable-heads.md) (hard-trigger extraction + React/Ignore gate), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (stable-prefix/dynamic-section discipline), [018/024 — Social tools](018-multi-agent-social.md) (`talk_to` entry point)
- Package: `shared` (marker type + bridge extension), `engine` (marker store on turns, trigger priority in the scheduler, address events), `cognition` (address line rendering in the dynamic section)

## Requirements

- **R1 — Pending-address marker.** When `ConversationManager.openOrContribute` lands a turn, every *other* current participant of that conversation is marked with a pending-address record `{addressedBy: agentId, conversationId, tick}` on their agent state. The marker is cleared when the marked agent contributes to that same conversation (their reply). Markers are per-conversation: contributing to conversation X clears only X's marker. (AC-1, AC-4)

- **R2 — Perception surface with presence + freshness.** The addressed agent's perceive context includes an address line rendering the actual pending address: "«Speaker name» addressed you: '«turn content»' — the conversation is open; respond with `talk_to`". This builds on spec 043's bridge (which renders the full conversation snapshot); the marker *guarantees presence* (the line cannot be missing while a marker exists) and *freshness* (it reflects the latest turn addressed at the agent). Address lines are per-agent, per-tick dynamic state → **dynamic section only** (spec 021). (AC-1)

- **R3 — Soft System 1 trigger (force the cycle, not the reply).** A pending-address marker acts as a trigger at the same strength as drive-threshold crossings: the target's next scheduler pass forces their PPER cycle so a reply never waits on the target's own motivation. It is NOT a hard alarm: the gate still runs and is recorded on, existing `HardTriggerFlags` semantics are untouched (AC-6), and no forced-reply action is injected — the plan remains LLM-authored, and with the guaranteed address line (R2) the plan includes a reply step to the addresser. (AC-2, AC-6)

- **R3.1 — Scheduler priority for addressed agents.** The scheduler evaluates address-marked agents ahead of the round-robin cursor scan, so a forced cycle fires on the same tick the marker is observed even when the round-robin would reach the target much later (with `maxConcurrentCycles=1` an addressed agent jumps the queue; concurrency limits are still respected). (AC-2)

- **R4 — Clearing and decay.** The marker clears when the target contributes to that conversation (their reply — the normal path), when the conversation closes (explicit `leave` of the last participant, idle timeout at `idleTimeoutTicks`, last participant despawns), or when the addresser is no longer a participant (A left — a stale address decays with the conversation lifecycle). A marker never outlives its conversation. (AC-4)

- **R5 — Marker as events.** Address and acknowledge (reply-to-address) events are emitted to the engine event stream (`events.jsonl`), extending spec 043 R4's per-turn metrics so reply rate can be measured directly: `conversation_addressed` (target marked) and `conversation_reply` (target's contribution to the conversation that addressed them). (AC-5)

## Acceptance Criteria

- [ ] **AC-1** (R1, R2): In a unit test, after A's `talk_to` lands a turn on co-located B, B's agent state carries the pending-address marker (`addressedBy: A, conversationId, tick`), and B's next assembled perception contains the address line with A's actual message text and B's name/address framing.
- [ ] **AC-2** (R3, R3.1): With `maxConcurrentCycles=1` and a busy round-robin, B's next cycle fires on the first scheduler pass after the marker exists (B jumps the queue); the produced plan includes a reply step targeting A via `talk_to` (the plan is LLM-authored — the test asserts a reply step, not an injected action).
- [ ] **AC-3** (R1): B's reply via `talk_to` extends the SAME conversation: engine-side turn window grows, B's `turnCount ≥ 2`, status `open → active`, no new conversation object is created (spec 033 lifecycle tests unchanged and green).
- [ ] **AC-4** (R1, R4): The marker is cleared after B's reply (unit test). Separately: a conversation closed by idle timeout (or by the addresser leaving) removes any outstanding marker — a stale marker never survives its conversation.
- [ ] **AC-5** (R5): Live validation run (built `dist/`, ≥3 agents, ≥60 min): reply rate > 0 (was 0 across 5 runs) computable from `events.jsonl` via the R5 events; ≥3 conversations with ≥2 turns.
- [ ] **AC-6** (R3): Full suite green; spec 043's tests unchanged; `HardTriggerFlags`, `NO_HARD_TRIGGERS`, and `System1TriggerSourceImpl` hard-trigger semantics untouched (no shared-contract change to the gate inputs); no forced-reply/injection path exists in the execution flow.

## Constraints
- **Package boundaries:** `shared` (marker type + perception-snapshot field + bridge method) ← `engine` (marker store, scheduler priority, events) and ← `cognition` (rendering). No new cross-package edges; no import cycles; `shared` stays dependency-free.
- **Dependency:** spec 043 must land first — the address line rides on 043's perception bridge rendering; this spec adds the marker (guaranteed presence + freshness) and the trigger, not a parallel rendering path.
- **KV-cache discipline (spec 021):** address lines are per-agent, per-tick dynamic state — dynamic section only (after the `---` separator); never in `stableLines`.
- **Bridge pattern (ADR-0001):** engine implements, cognition consumes. Marker access flows through `ConversationBridge`/snapshot types in `shared` — cognition never touches the ConversationManager directly.
- **Soft-trigger semantics:** the trigger forces the *cycle* (gate cannot ignore an address), but must not force the *plan* — no bypass of the PPER loop, no injected reply action, no hard-alarm interruption path. A greeting deserves a response, but the agent may still fold it into other work; the guaranteed address line makes the reply step the natural plan outcome.
- **What NOT to do:** no changes to conversation lifecycle (spec 033) or gate hard-trigger semantics (spec 035's `HardTriggerFlags` contract); no new primary social tool (spec 033 Decision 2 stands); no LLM calls on the marker/snapshot path (deterministic formatting only); no stable-section placement of address state; no edits to `dist/`.
