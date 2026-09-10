# Feature: Assembly Conversation Wiring — Connect the Conversation Bridge in `examples/assembly.ts` So Live Sims Run `talk_to` on the Conversation Path

> Issue: [#165](https://github.com/Redna/evol-hive/issues/165) — "conversationBridge never wired in
> examples/assembly.ts — live sims run talk_to on the legacy path; spec 033/043 conversation machinery
> is dormant." User-observed symptom: "agents don't really converse." Across every live run,
> conversations are structurally one-turn or absent. Technical audit found the root cause: the
> production assembly constructs `CognitiveToolExecutorImpl` with `socialBridge: social` but **no**
> `conversationBridge`, and never calls `social.setConversationManager(core.conversationManager)`.
> Every spec 033/043/044 conversation capability is therefore dead in live runs while QA suites pass
> (they wire the bridge correctly inside the tests — the tested component is real; the production
> assembly omits the wire).

## Context
- Architecture: [§2 System Overview](../architecture/02-system-overview.md) (assembly / core wiring), [§6 PPER Loop & Environmental Awareness](../architecture/06-pper-loop.md) (perception consumption of conversation state), [§8 Cognitive Tools](../architecture/08-cognitive-tools.md) (`CognitiveToolExecutor` construction and bridge ports)
- Related specs: [033 — Conversations as Perceivable Temporal Objects](033-conversations-identity-evolution.md) (R1/R3 `openOrContribute` path, R6 sentiment-gated deltas, AC-14 legacy fallback), [043 — Conversation Perception Bridge](043-conversation-perception-bridge.md) (pending-address line — dormant until the delegate is wired), [044 — Social Urge Model](044-social-urge-model.md) (reciprocity counters via conversations, exactly-once counter tests), [019 — Wire SocialManager in Assembly](019-wire-social-manager.md) (prior assembly-wiring spec; same drift family), [042 — Visualizer Single Renderer](042-visualizer-single-renderer.md) / issue [#155](https://github.com/Redna/evol-hive/issues/155) (same assembly-drift family, opposite direction)
- Package: `examples` only (`examples/assembly.ts`). No `src/` changes in shared, engine, cognition, or memory — all required machinery exists, is tested, and is already wired inside `createEngineCore` (`packages/engine/src/assembly.ts:226`).

## Verified root cause (live evidence)

- `examples/assembly.ts:306` constructs `CognitiveToolExecutorImpl({ stateDataProvider, socialBridge: social, mutationPort, ... })` — no `conversationBridge`.
- `examples/assembly.ts:260` constructs a **second** `SocialManager` (`const social = socialManager ?? new SocialManager(core.agentManager)`) that never receives `setConversationManager`, even though `createEngineCore` already wired its own `core.socialManager` to `core.conversationManager`.
- Consequences, all verified live: (1) `executeTalkTo` takes the legacy path — `openOrContribute` is never called, so **no conversation objects are ever created** (no turn windows, no sentiment gating, no close-time consolidation); (2) every `[social]` telemetry line shows the exact legacy fallback constants `trust=+2 familiarity=+5`; (3) `getConversationsAwaitingAgentReply` → `[]` always (spec 043 pending-address lines never render); (4) spec 033/043/044 machinery in `core.conversationManager` is consulted by nothing.

## Requirements

- **R1 — Conversation bridge into the cognitive tool executor.** `CognitiveToolExecutorImpl` in `examples/assembly.ts` must be constructed with `conversationBridge: core.conversationManager` — the exact `ConversationManagerImpl` created by `createEngineCore`, so `talk_to` joins/opens real threads via spec 033 R1/R3 `openOrContribute` and the delta becomes a deterministic function of the conversation's aggregate sentiment (spec 033 R6). (AC-1, AC-3)

- **R2 — One SocialManager holding both roles.** The sim's `SocialManager` must serve as both the `socialBridge` for the cognitive tool executor **and** the conversation-query delegate for the engine's perception path: `social.setConversationManager(core.conversationManager)` must be called on the instance that is passed as `socialBridge`. Alternative accepted: reuse `core.socialManager` as the socialBridge instead of constructing a second instance — either satisfies this requirement, but the invariant is that **exactly one** SocialManager instance holds both roles. (AC-2, AC-4)

- **R3 — No duplicate perception wiring.** The perception provider's `setConversationManager`/`setTickSource` are already inherited from `createEngineCore` (`examples/assembly.ts` lines ~280/284, via `core.bridges.perception`); the fix must not re-wire or double-wire them, and must not create a second `ConversationManagerImpl`. (AC-6)

- **R4 — No regression, legacy path preserved.** The legacy blind `+5/+2` fallback in `executeTalkTo` remains for contexts that intentionally wire no conversation bridge (spec 033 AC-14 backward compat); spec 044's exactly-once counter tests (legacy + conversation paths) pass unmodified; full suite green. (AC-5)

## Acceptance Criteria

- [ ] **AC-1** (R1): In a live run with real LLM, a `talk_to` opens a conversation object (conversation count > 0 observable), and sentiment-gated deltas replace legacy constants — `[social]` telemetry lines show non-legacy values (not `trust=+2 familiarity=+5` on every exchange).
- [ ] **AC-2** (R2): The target's next perception includes the spec 043 pending-address line quoting the actual message text (`getConversationsAwaitingAgentReply` no longer returns `[]`).
- [ ] **AC-3** (R1): A reply extends the **same** thread — `turnCount ≥ 2`, status transitions per spec 033 lifecycle, and the exchange is visible in `events.jsonl`.
- [ ] **AC-4** (R2): Urge-model reciprocity now counts real replies — the target's `receivedCount` increments on their contribution (spec 044 R2 behavior observable in live events).
- [x] **AC-5** (R4): Full suite green (`pnpm test`); spec 044's exactly-once counter tests (legacy + conversation paths) unchanged and passing; every spec 033 lifecycle/bridge test passes unmodified. *(Verified 2026-09-10 on PR #172: 2,323 passed / 0 failed across all 7 packages.)*
- [x] **AC-6** (R3): The diff touches `examples/assembly.ts` only (plus docs); no second `ConversationManagerImpl` is constructed in the examples assembly and no duplicate `setConversationManager`/`setTickSource` calls appear on the perception provider (code-review check; grep assertion: exactly one `new SocialManager` path in `assembleCognition` and zero new `ConversationManagerImpl` constructions). *(Verified — plus one deviation: `packages/engine/tests/spec-018-coverage.test.ts` had its stale `Total specs:` regex uncapped (test-only, no src/ changes) so the honest INDEX recount (61) keeps the suite green; see commit 4c391de.)*

## Live validation (PR #172, 2026-09-10 — real LLM: glm-5.3-flash via Ollama Cloud, 10 min, coffee-shop scene)

**Proven live** (log: `session-logs/045-live-run.log`, harness: gitignored
`examples/live-conv-validation.ts` polling the production-constructed
`conversationManager`): before the fix `openOrContribute` was never called —
zero conversation objects existed across every prior live run. After the fix,
3 conversations were created and visible in the manager
(`conv-1789023234632-1..3`, each with the speaker's real opening turn), and the
speaker-side reciprocity counter accumulated on repeat exchanges
(`Carol→Bob sentCount=2`, spec 044 R2). The delta values in the `[social]`
telemetry (+5/+2) came from the conversation path's aggregate-sentiment
function (all turns neutral) — for neutral/positive exchanges it coincides
with the legacy constants by design (spec 033 R6: only a negative-dominant
exchange differs, +1/+0).

**Live-run AC-1/2/3/4 remain open — two cognition-layer gaps discovered by
this validation, both outside this spec's `examples/assembly.ts` package
boundary** (filed as issue — see #165 comment):

1. **Name-keyed targeting**: the perception renders `Agents present: Bob (…)`
   (names only, `perception-builder.ts:82`) while the tool schema asks for
   `targetAgentId` — so the LLM passes display names (`talk_to→Bob`), and the
   executor never resolves them. Conversations open with a phantom participant
   that has no agent state, so the lifecycle co-location sweep (R7) removes it
   and closes the thread within one tick. The real target never becomes a
   participant: no pending-address line (AC-2), no same-thread reply (AC-3),
   no `receivedCount` on the real target (AC-4), and `queueMessage` delivers
   to a phantom key. Root-cause candidate for #167's reply-rate-0 mystery.
2. **Sentiment argument dropped**: the mid-loop tool-call path
   (`openai-client.ts:662`) invokes `executeTalkTo(agentId, targetAgentId,
   message)` — the LLM's `sentiment` tag never reaches the executor, so live
   exchanges are always tagged neutral regardless of the LLM's choice.

The machinery behind AC-2/AC-3/AC-4 is deterministic and QA-proven with real
agent IDs (`examples/tests/spec-045-assembly-conversation-wiring.test.ts`,
sections 4–5); only the live-run observability awaits the follow-up fix.

## Constraints
- **Package boundaries:** `examples/assembly.ts` only. Do not modify `shared`, `engine`, `cognition`, or `memory` source — the machinery (ConversationManager, bridge ports, perception rendering, counters) already exists and is covered by QA E2E suites. If a "wired" component appears broken, suspect the assembly, not the component (spec 042 lesson).
- **Instance identity:** the `conversationBridge` handed to `CognitiveToolExecutorImpl` and the delegate handed to `SocialManager.setConversationManager` must be the same `core.conversationManager` object created by `createEngineCore` — never a second instance (turn windows, sentiment aggregation, reciprocity, and consolidation must consult one graph of state).
- **Backward compatibility:** do not remove the legacy fallback constants in `executeTalkTo` (spec 033 AC-14); unwired contexts (unit tests, QA suites that construct the executor bare) must keep passing.
- **KV-cache discipline (spec 021):** no changes to prompt construction — the pending-address line and active-conversations section remain dynamic-section state rendered by the existing perception-builder.
- **What NOT to do:** no re-wiring of the perception provider (it is inherited correctly); no new bridge methods or spec amendments to 033/043/044; no new SocialManager or ConversationManager constructions in `examples/assembly.ts`; no edits to `dist/`; no scope creep into perception rendering (that is spec 043's already-drafted territory — this spec only supplies the missing wires it needs).
