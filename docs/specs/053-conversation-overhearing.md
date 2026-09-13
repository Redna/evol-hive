# Feature: Room-Perceivable Conversation Content — Bystanders Overhear Turns Without Joining

> Drafted from [Issue #192](https://github.com/Redna/evol-hive/issues/192).

## Context

- Architecture: [§4 Smart Objects & Affordances](../architecture/04-smart-objects.md), [§6 PPER Loop](../architecture/06-pper-loop.md) (Perceive phase)
- Related specs: [033](033-conversations-identity-evolution.md) (conversation objects — **R3's observe-privacy rule is superseded here**), [043](043-conversation-perception-bridge.md) (conversation→perception bridge), [044](044-social-urge-model.md) (pending-address INFORMATION lines, influence-not-force), [049](049-dialogue-completion-urge-observability-reply-window.md) (fresh-address salience, dynamic-section pattern, per-cycle diagnostic), [021](021-kv-cache-prompt-optimization.md) (stable/dynamic section discipline), [046](046-talk-to-target-resolution-sentiment-passthrough.md) (ID-alongside-display-name rendering)
- Package: shared, engine, cognition

Spec 033 R3 deliberately hid conversation turns from non-participants: `observe` shows only topic +
participants, and passive perception surfaces nothing about the content. That makes rooms feel
deaf — two agents can hold a multi-turn exchange inches from a third agent who perceives only an
opaque topic label, then joins with no idea what was said.

**Design direction (agreed in the issue): co-location implies perception of the content.** A
bystander in the room perceives *what is being talked about* — the actual turns — without joining,
like overhearing people talking next to you. Two channels:

1. **Passive (R1):** recent turns arrive in the bystander's perception context every cycle —
   no affordance, no action, co-location is the only gate.
2. **Explicit (R2):** `observe` is upgraded to return the full turn history on demand — still
   without granting participation.

## Requirements

Each requirement is tagged with the acceptance criterion (AC) that verifies it.

- **R1 — Passive overheard-turn perception (shared + engine + cognition).** A co-located
  non-participant passively perceives the recent turns of every open/active conversation in their
  room, with no affordance invocation. Engine side: a deterministic provider method on the
  perception provider (mirroring `getConversationsAwaitingAgentReply`, spec 044) returns, for the
  agent's current room only, each non-closed conversation the agent does **not** participate in,
  as an `OverheardConversation` (`conversationId`, `topic`, bounded `lines`). Cognition side: the
  lines render in the **dynamic section** as
  `INFORMATION: Overheard — {initiatorName} to {otherName}: "{content}"` (spec 049 freshness
  pattern: INFORMATION lines, dynamic section only — never the stable section, never a trigger;
  the LLM keeps the decision, spec 044 R5). Names resolve display names via `agentsPresent` with
  the agent-ID fallback (spec 046 R4 pattern). (AC-1, AC-4)
- **R2 — Bounded rolling scope and per-cycle cap.** Overheard scope is the rolling
  `CONVERSATION_TURN_WINDOW` (8 turns, spec 033 R4), rendered **latest first**, capped at
  `CONVERSATION_OVERHEARD_LINES_PER_CYCLE = 3` lines per conversation per cycle (new shared
  constant) to bound the prompt budget. A conversation with more recent turns than the cap renders
  only its latest 3. (AC-4)
- **R3 — `observe` upgraded to full history (shared + engine).** `ConversationObserveResult`
  gains a `turns` array (full rolling-window history: `{ agentId, content, sentiment, tick }`,
  oldest first) and its message names the speakers. `observe` continues to expose exactly the
  same affordance to the same eligible agents (co-located non-participants per spec 033 R3 role
  rules) and **still does not add the caller to `participants`** — observation is not
  participation. (AC-2)
- **R4 — Room-wall scope.** Only agents in the conversation's room perceive its content. The
  provider filters on `agentManager.getState(agentId)?.location === conversation.roomId`; agents
  in other rooms receive no overheard lines for that conversation. No radius/adjacency model —
  room walls stay the perception boundary (out of scope here). (AC-3)
- **R5 — Participant view unchanged; spec 033 R3 superseded.** Participants' own view of their
  conversations is unchanged (thread context via pending-address markers, spec 044 R4a — they
  never receive "overheard" lines for conversations they participate in). The spec 033 R3 privacy
  rule ("non-participants see topic + participants, not turns") is **superseded**: the spec 033
  doc gains a superseded-note on R3 pointing here, and its `observe` description is annotated.
  Stable perception lines remain byte-identical for a given room + object set (spec 021 AC-3
  discipline). (AC-5, AC-6)
- **R6 — Overheard telemetry (cognition).** A new one-line per-cycle `[overheard]` diagnostic,
  built on the `social-urge-diagnostic.ts` pattern (spec 049 R1): emitted at the perceive→plan
  seam whenever the agent's perception includes at least one overheard line; carries agent id,
  tick, and per-conversation `conversationId|lines-rendered|lines-available`. Constraints
  inherited: zero LLM calls, exactly one `console.log` line, never dumps the LLM context, never
  throws (a logging failure can never break a cycle). Absence of the line when nothing is
  overheard is itself meaningful. (AC-7)

**Live/soft acceptance (LLM behavior, not unit-testable):** a bystander who later joins (or opens
a `talk_to` with) a participant shows awareness of overheard content — e.g. replying to or
referencing an overheard turn. Verified as a live-run observation, not a deterministic test. (AC-8)

## Acceptance Criteria

- [ ] **AC-1** (R1): Unit test — with an active conversation in agent A's room (A a
  non-participant), A's `PerceptionResult.overheard` contains the conversation and the
  perception-builder renders `INFORMATION: Overheard — …` lines **below the `---` separator**
  (dynamic section only, spec 021); display names come from `agentsPresent`, with agent-ID
  fallback for absent speakers.
- [ ] **AC-2** (R3): Unit test — `observe` returns `topic`, `participants`, and the full
  rolling-window `turns` (agent, content, sentiment, tick); the observing agent is **not** added
  to `participants`; a non-participant's eligible-affordance set still contains `join`/`observe`
  only (no `contribute`).
- [ ] **AC-3** (R4): Unit test — the same conversation is absent from the `overheard` result of an
  agent in a different room; an agent in the room but participating in the conversation also gets
  no overheard entry for it (R5).
- [ ] **AC-4** (R1, R2): Unit test — a conversation with 8 turns renders exactly 3 overheard lines,
  latest turn first; a conversation with 1 turn renders exactly 1; order within the rendered lines
  is latest-first.
- [ ] **AC-5** (R5): Unit test — a participant's perception contains no overheard lines for their
  own conversation; the spec-021 stable-section test (stable lines byte-identical for a given room
  + object set) still passes unchanged.
- [ ] **AC-6** (R5): Spec 033 doc carries a superseded-note on R3 pointing to this spec; no other
  033 text is rewritten.
- [ ] **AC-7** (R6): Unit test — when ≥1 overheard line renders, exactly one `[overheard]` line is
  logged with per-conversation counts (`lines-rendered` respects the ≤3 cap); when nothing is
  overheard, no line is logged; the diagnostic never throws on empty/missing fields.
- [ ] **AC-8** (live, R1): In a live multi-agent run, an agent that overheard turns and then joins
  (or opens a `talk_to` with) a participant references the overheard content in its first
  contribution (soft criterion — recorded as run evidence, not asserted in CI).
- [ ] **AC-9** (all): All existing tests pass; no LLM call on any deterministic path (overheard
  selection, capping, rendering, diagnostics are pure TypeScript); no schema change to
  `ConversationObject` and no `SAVE_FORMAT_VERSION` bump (overheard perception is a derived,
  read-only view — nothing new is persisted).

## Constraints

- **Package boundaries:** shared ← engine, shared ← cognition. The `OverheardConversation` type,
  the `CONVERSATION_OVERHEARD_LINES_PER_CYCLE` constant, and the extended
  `ConversationObserveResult` live in `shared` (`packages/shared/src/types/conversation.ts`);
  the engine owns the deterministic provider (`ConversationManagerImpl` + perception-provider
  pass-through, mirroring `getConversationsAwaitingAgentReply`); cognition owns rendering in
  `perception-builder.ts` and the diagnostic (ADR-0001 bridge pattern).
- **KV-cache discipline (spec 021):** overheard lines are per-agent, per-tick dynamic state —
  dynamic section only, below `---`. No stable line may change content or position. The
  `FRESH:` promotion pattern (spec 049 R3) is NOT applied here — overhearing is ambient, not
  an owed reply; no reordering above the drive lines.
- **Prompt budget bounded:** ≤3 overheard lines per conversation per cycle
  (`CONVERSATION_OVERHEARD_LINES_PER_CYCLE`); scope limited to the 8-turn rolling window that
  already exists on the object — no new unbounded state (Redna/yaam#124 bug class).
- **Influence, not force (spec 044 R5):** overheard lines are INFORMATION, never a trigger or
  directive; they must not create pending-address entries, urges, or any engine-side obligation
  for the bystander.
- **No persistence changes:** overheard perception is derived at read time from the existing
  rolling window. Do not extend `ConversationObject`, do not bump `SAVE_FORMAT_VERSION`, do not
  touch `DynamicWorldSnapshot`.
- **Reuse, don't rebuild:** co-location check reuses the same `location === roomId` gate as
  `getEligibleAffordances` (spec 033 R3); display-name resolution reuses the spec 046 pattern;
  the diagnostic reuses the `social-urge-diagnostic.ts` skeleton (spec 049 R1).
- **Strict TS:** `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`
  (`import type` for types), 100-char width.
- **What NOT to do:** do not give bystanders `contribute` or any participation rights via
  overhearing; do not render overheard content into the stable section or into `observe`'s
  affordance eligibility; do not leak turns across rooms (no radius model); do not gate
  overhearing on any affordance or classifier output — co-location is the only gate; do not
  block the synchronous game loop on LLM responses.
