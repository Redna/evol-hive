# Feature: Conversation Perception Bridge — Surface Conversation State to the LLM's Perception

> Issue: [#158](https://github.com/Redna/evol-hive/issues/158) — "Conversations are structurally one-turn:
> conversation state is never surfaced to the LLM's perception." Spec 033 built the full engine-side
> ConversationManager (lifecycle, rolling window, sentiment, roles, close-time consolidation), but **none of
> it reaches the LLM's context**: `grep -r conversation packages/cognition/src/pper/` → 0 hits. Live-run
> evidence: 24 `talk_to` exchanges across 3 agents, every one a single-turn greeting, zero replies —
> because targets are never told someone spoke to them, and initiators cannot see their own open thread.

## Context
- Architecture: [§6 PPER Loop & Environmental Awareness](../architecture/06-pper-loop.md) (perceive-phase context construction), [§8 Cognitive Tools](../architecture/08-cognitive-tools.md), [§10 Cognitive Guardrails](../architecture/10-cognitive-guardrails.md)
- Related specs: [033 — Conversations as Perceivable Temporal Objects](033-conversations-identity-evolution.md) (lifecycle, bridge, privacy boundary, consolidation), [021 — KV-Cache Prompt Optimization](021-kv-cache-prompt-optimization.md) (stable-prefix/dynamic-section discipline), [018/024 — Social tools](018-multi-agent-social.md) (`talk_to` entry point)
- Package: `shared` (bridge interface extension + perception types), `engine` (perception assembly snapshot), `cognition` (perception-builder rendering, dynamic tool description)

## Requirements

- **R1 — Participant conversation perception.** When an agent's perception is assembled, the engine attaches a snapshot of every `open`/`active` conversation the agent participates in, and the perception-builder renders an "Active conversations" section in the LLM context: the other participant(s) by name, the topic, and the last N turns of the rolling window (spec 033 `CONVERSATION_TURN_WINDOW`), phrased as actionable direction ("Iris said to you: 'Hello…' — the conversation about herbs is open; contribute with `talk_to`"). This context is **per-agent dynamic state → dynamic section only** (spec 021 stable-prefix rules). (AC-1, AC-2, AC-3)

- **R2 — Non-participant privacy boundary.** Non-participant co-located agents see only topic + participants for conversations they could `join` — never the turn window. This reuses spec 033 R3's `observe` privacy boundary; the perception snapshot for non-participants carries exactly the fields `ConversationObserveResult` exposes. (AC-6)

- **R3 — State-aware `talk_to` description.** The `talk_to` tool definition presented to the LLM reflects conversation state: when the speaker has an open conversation with a present agent, the description says "contribute to the ongoing conversation with X (topic: …)"; otherwise it describes starting a new conversation. The static `talkToTool` const in `shared` remains the base; the perception-builder clones it per-agent when rendering tools. (AC-7)

- **R4 — Multi-turn measurability.** Conversation multi-turn behavior becomes measurable per run: conversations with ≥2 turns (turnCount of the non-initiator ≥ 1 — i.e., a reply), initiator follow-ups, and total multi-turn conversations. Emitted as engine events (existing `events.jsonl` stream) so live validations can compute reply rate. (AC-4)

- **R5 — Richer close-time consolidation.** Close-time consolidation memories (spec 033 R5) include the actual exchanged turn texts from the rolling window (both sides), not just a role/sentiment summary, so dream-training data (spec 035) captures real dialogue. (AC-8)

- **R6 — No lifecycle changes.** The ConversationManager's open→active→closed lifecycle, 120-tick idle timeout, rolling window cap, and sentiment/role derivation are unchanged; this spec is a **perception-side bridge only**. Spec 033's public behavior and tests must not regress. (AC-5)

## Acceptance Criteria

- [ ] **AC-1** (R1): In a unit test, after A calls `talk_to` to co-located B, B's next assembled perception includes the conversation — participant name, topic, and A's last turn text visible in the rendered "Active conversations" section.
- [ ] **AC-2** (R1): B contributing via `talk_to` extends the **same** conversation: the engine-side object's turn window grows, B's `turnCount ≥ 2`, and status transitions `open → active` (spec 033 lifecycle tests unchanged and green).
- [ ] **AC-3** (R1): A's next perception shows their own open thread (their prior turn visible) — the unit test asserts A's context contains the conversation and its own last turn, so re-greeting from scratch is contextually impossible.
- [ ] **AC-4** (R4): Live validation run (60 min, ≥3 agents, built `dist/`): ≥3 conversations with ≥2 turns; reply rate (contributions by the non-initiator) > 0 — currently 0 across 5 runs; events emitted per turn allow computing these metrics from `events.jsonl`.
- [ ] **AC-5** (R6): Full suite green; every spec 033 lifecycle/bridge/persistence/QA test passes unmodified.
- [ ] **AC-6** (R2): A co-located non-participant's perception snapshot for the conversation contains topic + participants only; the rendered section for them contains **no** turn text (asserted in a unit test).
- [ ] **AC-7** (R3): With an open conversation between the speaker and a present agent, the `talk_to` tool definition rendered by the perception-builder contains the contribute-to-existing-conversation wording; without one, it contains the start-a-new-conversation wording (unit test on the built payload).
- [ ] **AC-8** (R5): On conversation close, each participant's consolidation memory includes the exchanged turn contents (both sides), not only the role/sentiment summary (unit test on the consolidation path).

## Constraints
- **Package boundaries:** `shared` (type additions: perception snapshot field + bridge method) ← `engine` (snapshot assembly, turn events) and ← `cognition` (rendering). No new cross-package edges; no import cycles; `shared` stays dependency-free.
- **KV-cache discipline (spec 021):** conversation lines are per-agent, per-tick dynamic state — they go in the **dynamic section only** (after the `---` separator). Turn text must never enter `stableLines`. The state-aware `talk_to` description is likewise dynamic (per-agent tool list already is).
- **Bridge pattern (ADR-0001):** engine implements, cognition consumes. Add the minimal new method(s) to `ConversationBridge` (e.g., a per-agent perception view returning participant-turns vs observer topic-only views) rather than exporting the ConversationManager itself.
- **Privacy:** reuse spec 033 R3's participant/observer boundary — do not leak turn text to non-participants anywhere in the perception path.
- **What NOT to do:** no changes to conversation lifecycle, no new primary social tool (spec 033 Decision 2 stands), no LLM calls on the perception-snapshot path (it must stay deterministic — pure formatting), no stable-section placement of conversation state, no edits to `dist/`.
