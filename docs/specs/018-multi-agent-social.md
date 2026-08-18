# Feature: Multi-Agent Social — Agent-to-Agent Perception, Communication & Relationships

## Context
- Architecture: [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentDrives, AgentInternalState, AgentProfile), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Perceive phase, spatial debouncing, PassivePerception), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (cognitive tool registry, tool calling), [§9 — Engine Routing](../architecture/09-engine-routing.md) (isThinking, feedback store)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md) (PerceptionResult, PassivePerception, PerceptionDataProvider bridge), [002 — Plan Phase](002-plan-phase.md) (PlanBuilder, LLMContextPayload), [003 — Execute Phase](003-execute-phase.md) (ExecuteDataProvider, AffordanceResult), [012 — Agent Persona System](012-agent-persona-system.md) (AgentProfile.relationships, formatPersona), [013 — Richer Prototype Scenes](013-richer-prototype-scenes.md) (multi-agent scenes, social affordances on objects), [015 — Full Cognitive Tools](015-full-cognitive-tools.md) (CognitiveToolExecutor, tool execution mid-loop), [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (affordance masking, plan validation)
- Package: `shared` (new types: AgentSummary, SocialMessage, RelationshipMap, RelationshipEntry; extensions to PassivePerception, PerceptionResult, PerceptionDataProvider, AgentInternalState, AgentProfile, CognitiveToolName), `engine` (MessageQueue, relationship management, agent-perception bridge methods, social affordance registration), `cognition` (perception-builder and plan-builder social context injection, talk_to cognitive tool)
- Issue: [#62](https://github.com/Redna/evol-hive/issues/62)

## Design Rationale

Agents currently coexist in the same world but are entirely isolated: the Perceive phase only surfaces objects and rooms, never other agents. The `social` drive exists in `AgentDrives` but has no behavioral consequence — there is no mechanism for agents to seek out or interact with each other. Spec 013 explicitly noted that "direct agent-to-agent affordance targeting is not implemented" and deferred structured social dynamics to this spec.

This spec introduces five capabilities: (1) agent-to-agent perception, (2) social affordances, (3) inter-agent communication via a message queue, (4) relationship tracking, and (5) social drive activation. The design follows the existing bridge pattern: new types live in `shared`, engine-side data providers implement bridge interfaces, and cognition-layer builders consume them. Communication uses a `MessageQueue` (engine-owned, per-agent inboxes) that injects pending messages into the perception stream — analogous to the existing `SystemFeedbackStore`. Relationships are stored as a structured `RelationshipMap` on `AgentInternalState` (replacing the free-form `relationships?: Record<string, string>` on `AgentProfile`, which remains for static persona descriptions).

Social affordances (`talk_to`, `observe_agent`, `help`, `ignore`) are registered dynamically by the perception data provider when other agents are present. They appear in `prunedAffordances` alongside physical affordances, so the existing affordance resolution and execution flow in the Execute phase is reused. `talk_to` is also exposed as a cognitive tool (per issue requirement and §8) so the LLM can call it during the tool-calling loop. The `talk_to` handler enqueues a `SocialMessage` into the target agent's inbox; the target agent sees the message on its next Perceive tick via a new `socialContext` field on `PassivePerception`.

The `social` drive (already in `AgentDrives`) is activated by the existing `DriveSystem`: low social drive (value near 0) makes the agent's primary drive label indicate social need, and the `DriveSystem.getPrimaryDrive` already selects the lowest drive. No changes to `DriveSystem` are needed — the social drive simply needs to be decayed and modified by social interactions, which already works through the existing `applyChanges` and `applyDecay` methods. Social affordance handlers return `driveChanges: { social: +N }` to satisfy the social drive after interaction.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`AgentSummary` type** — Add a new interface `AgentSummary` to `packages/shared/src/types/agent.ts`:
   ```typescript
   interface AgentSummary {
     agentId: string;
     name: string;
     currentActivity: string;
     isThinking: boolean;
   }
   ```
   `currentActivity` is derived from the agent's current plan step description (or "idle" when no plan is active).

2. **`SocialMessage` type** — Add a new interface `SocialMessage` to `packages/shared/src/types/agent.ts`:
   ```typescript
   interface SocialMessage {
     fromAgentId: string;
     fromAgentName: string;
     content: string;
     timestamp: number;
   }
   ```
   `timestamp` is simulation time (seconds since start).

3. **`RelationshipEntry` type** — Add a new interface `RelationshipEntry` to `packages/shared/src/types/agent.ts`:
   ```typescript
   interface RelationshipEntry {
     trust: number;       // -100 to 100 (negative = distrust)
     familiarity: number;  // 0 to 100
     lastInteraction: number; // simulation timestamp (seconds)
   }
   ```

4. **`RelationshipMap` type** — Add `type RelationshipMap = Record<string, RelationshipEntry>` to `packages/shared/src/types/agent.ts`. Keyed by agent ID.

5. **`relationships` on `AgentInternalState`** — Add an optional field `relationships?: RelationshipMap` to `AgentInternalState` in `packages/shared/src/types/agent.ts`. This is the live, mutable relationship map updated during interactions. It is separate from the existing `AgentProfile.relationships?: Record<string, string>` (which is static persona text used by `formatPersona`).

6. **`agentsPresent` on `PassivePerception`** — Add an optional field `agentsPresent?: AgentSummary[]` to `PassivePerception` in `packages/shared/src/types/cognition.ts`. When populated, it lists other agents currently in the same room as the perceiving agent (excluding the perceiving agent itself). When no other agents are present, the field is `undefined` (not an empty array — keeps the perception payload minimal).

7. **`socialContext` on `PassivePerception`** — Add an optional field `socialContext?: SocialMessage[]` to `PassivePerception` in `packages/shared/src/types/cognition.ts`. When populated, it contains pending social messages from other agents (delivered from the `MessageQueue`). After consumption by the Perceive phase, the messages are cleared from the queue. When no messages are pending, the field is `undefined`.

8. **`socialAffordances` on `PerceptionResult`** — Add an optional field `socialAffordances?: Affordance[]` to `PerceptionResult` in `packages/shared/src/types/cognition.ts`. These are dynamically generated affordances (`talk_to`, `observe_agent`, `help`, `ignore`) that target specific agents in the room. They are separate from `prunedAffordances` (which are physical affordances on smart objects) to avoid polluting the classifier pruning logic. The cognition layer merges them into the available actions presented to the LLM.

9. **`getAgentsInRoom` on `PerceptionDataProvider`** — Add an optional method to the `PerceptionDataProvider` interface in `packages/shared/src/types/cognition.ts`:
   ```typescript
   getAgentsInRoom?(roomId: string, excludeAgentId?: string): AgentSummary[];
   ```
   Returns `AgentSummary` objects for all agents in the room except `excludeAgentId`. When not implemented (older engines), the perception builder omits agent data.

10. **`getPendingMessages` on `PerceptionDataProvider`** — Add an optional method to the `PerceptionDataProvider` interface:
    ```typescript
    getPendingMessages?(agentId: string): SocialMessage[];
    ```
    Returns and clears pending social messages for the agent. When not implemented, social context is omitted.

11. **`getRelationships` on `PerceptionDataProvider`** — Add an optional method to the `PerceptionDataProvider` interface:
    ```typescript
    getRelationships?(agentId: string): RelationshipMap | undefined;
    ```
    Returns the agent's live relationship map, or `undefined` if none exists. When not implemented, relationship context is omitted.

12. **`enqueueMessage` on `ExecuteDataProvider`** — Add an optional method to the `ExecuteDataProvider` interface in `packages/shared/src/types/cognition.ts`:
    ```typescript
    enqueueMessage?(fromAgentId: string, toAgentId: string, content: string): boolean;
    ```
    Enqueues a `SocialMessage` into the target agent's inbox. Returns `true` on success, `false` if the target agent does not exist. When not implemented, `talk_to` fails gracefully.

13. **`updateRelationship` on `ExecuteDataProvider`** — Add an optional method to the `ExecuteDataProvider` interface:
    ```typescript
    updateRelationship?(agentId: string, targetAgentId: string, updates: Partial<RelationshipEntry>): void;
    ```
    Merges partial updates into the `RelationshipEntry` for `targetAgentId`. If no entry exists, creates one with defaults `{ trust: 0, familiarity: 0, lastInteraction: <current sim time> }` then applies the partial updates. `trust` is clamped to [-100, 100], `familiarity` to [0, 100].

14. **`getAgentName` on `ExecuteDataProvider`** — Add an optional method to the `ExecuteDataProvider` interface:
    ```typescript
    getAgentName?(agentId: string): string | null;
    ```
    Returns the agent's display name from its profile, or `null` if not found. Used by `talk_to` to populate `SocialMessage.fromAgentName`.

15. **`talk_to` cognitive tool definition** — Add `'talk_to'` to the `CognitiveToolName` union type in `packages/shared/src/types/cognition.ts`. Add a new `CognitiveTool` entry to the default catalog in `packages/cognition/src/tools/index.ts`:
    ```typescript
    {
      name: 'talk_to',
      description: 'Send a message to another agent in the same room. The message will appear in their next perception.',
      argsSchema: {
        type: 'object',
        properties: {
          targetAgentId: { type: 'string', description: 'The ID of the agent to talk to.' },
          message: { type: 'string', description: 'The message content to send.' },
        },
        required: ['targetAgentId', 'message'],
        additionalProperties: false,
      },
    }
    ```

16. **`TalkToToolResult` type** — Add a new interface to `packages/shared/src/types/cognition.ts`:
    ```typescript
    interface TalkToToolResult {
      success: boolean;
      targetAgentId: string;
      message: string;
      failureReason?: string;
    }
    ```

17. **`talkTo` on `CognitiveToolExecutor` interface** — Add a new method to the `CognitiveToolExecutor` interface in `packages/shared/src/types/cognition.ts`:
    ```typescript
    executeTalkTo(agentId: string, targetAgentId: string, message: string): Promise<TalkToToolResult>;
    ```
    The cognition-layer executor calls `ExecuteDataProvider.enqueueMessage` and `ExecuteDataProvider.updateRelationship` (when available), then returns the result.

### Engine Layer (`@evol-hive/engine`)

18. **`MessageQueue` class** — Create `packages/engine/src/agents/messages/index.ts` exporting a `MessageQueue` class:
    - Backed by `Map<string, SocialMessage[]>` (per-agent inboxes).
    - `enqueue(toAgentId: string, message: SocialMessage): boolean` — appends to the agent's inbox. Returns `false` if `toAgentId` does not correspond to a known agent (verified via `AgentManager.getState`). Returns `true` on success.
    - `dequeueAll(agentId: string): SocialMessage[]` — returns all pending messages and clears the inbox. Returns `[]` if none.
    - `peek(agentId: string): SocialMessage[]` — returns pending messages without clearing (for testing).
    - `clear(agentId: string): void` — clears the inbox for an agent.

19. **`MessageQueue` integration into `EngineCore`** — Add `messageQueue: MessageQueue` to the `EngineCore` interface in `packages/engine/src/assembly.ts`. Initialize it in `createEngineCore`. Wire it into `PerceptionDataProviderImpl` (for `getPendingMessages`) and `ExecuteDataProviderImpl` (for `enqueueMessage`).

20. **`PerceptionDataProviderImpl` — `getAgentsInRoom`** — Implement the `getAgentsInRoom(roomId, excludeAgentId)` method on `PerceptionDataProviderImpl` in `packages/engine/src/agents/perception/index.ts`. Iterate `agentManager.getActiveAgents()`, filter by `state.location === roomId` and `state.agentId !== excludeAgentId`, and map each to an `AgentSummary`:
    - `agentId`: the agent's ID
    - `name`: from `agentManager.getProfile(agentId)?.name ?? agentId`
    - `currentActivity`: `state.currentPlan?.steps[state.currentPlan.currentStepIndex]?.description ?? 'idle'`
    - `isThinking`: `state.isThinking`

21. **`PerceptionDataProviderImpl` — `getPendingMessages`** — Implement `getPendingMessages(agentId)` on `PerceptionDataProviderImpl`. Calls `messageQueue.dequeueAll(agentId)` and returns the result. This drains the queue on each perception tick.

22. **`PerceptionDataProviderImpl` — `getRelationships`** — Implement `getRelationships(agentId)` on `PerceptionDataProviderImpl`. Returns `agentManager.getState(agentId)?.relationships ?? undefined`.

23. **`ExecuteDataProviderImpl` — `enqueueMessage`** — Implement `enqueueMessage(fromAgentId, toAgentId, content)` on `ExecuteDataProviderImpl`. Verifies both agents exist via `agentManager.getState`. Constructs a `SocialMessage` with `fromAgentId`, `fromAgentName` (from profile), `content`, and `timestamp` (from the engine clock). Calls `messageQueue.enqueue(toAgentId, message)`. Returns `true` on success, `false` if the target agent doesn't exist.

24. **`ExecuteDataProviderImpl` — `updateRelationship`** — Implement `updateRelationship(agentId, targetAgentId, updates)` on `ExecuteDataProviderImpl`. Reads the agent's state, gets or creates the `RelationshipEntry` for `targetAgentId` (defaults: `{ trust: 0, familiarity: 0, lastInteraction: <current sim time> }`), merges the partial `updates` (clamping `trust` to [-100, 100] and `familiarity` to [0, 100]), and writes it back to `state.relationships`.

25. **`ExecuteDataProviderImpl` — `getAgentName`** — Implement `getAgentName(agentId)` on `ExecuteDataProviderImpl`. Returns `agentManager.getProfile(agentId)?.name ?? null`.

26. **Social affordance generation** — Add a function `generateSocialAffordances(agentsInRoom: AgentSummary[]): Affordance[]` to `packages/engine/src/agents/perception/index.ts` (or a new `packages/engine/src/agents/social/index.ts`). For each `AgentSummary` in the room, generate four `Affordance` objects:
    - `talk_to_<agentId>`: label `"Talk to <name>"`, engineEffect `"talk_to"`, preconditions `[]`, effects `{}`
    - `observe_agent_<agentId>`: label `"Observe <name>"`, engineEffect `"observe_agent"`, preconditions `[]`, effects `{}`
    - `help_<agentId>`: label `"Help <name>"`, engineEffect `"help"`, preconditions `[]`, effects `{ social: 10 }`
    - `ignore_<agentId>`: label `"Ignore <name>"`, engineEffect `"ignore"`, preconditions `[]`, effects `{ social: -5 }`

    These affordances are not registered in the `AffordanceRegistry` (they don't live on smart objects). They are injected into `PerceptionResult.socialAffordances` by the perception service and merged into the LLM context by the cognition layer. The Execute phase resolves them specially (see Req 28).

27. **Social affordance handler registration** — Register handlers for `talk_to`, `observe_agent`, `help`, and `ignore` engine effects in the `AffordanceRegistry`. These handlers are invoked by the Execute phase when a social affordance is resolved. Each handler receives `objectId` (set to the target agent's ID for social affordances), `agentId` (the acting agent), and `objectState` (unused for social affordances):
    - `talk_to`: The handler is a no-op at the physics level — the actual message enqueue happens via the `talk_to` cognitive tool path (Req 17). If reached via the Execute phase (physical affordance path), it enqueues a default message `"<actingAgentName> approaches you."` and returns `{ success: true, driveChanges: { social: 5 } }`.
    - `observe_agent`: Returns `{ success: true }` with no drive changes. The perception builder adds the observed agent's current activity to the next perception's `systemFeedback` via `feedbackStore.setSystemFeedback(agentId, "<name> is currently: <activity>")`.
    - `help`: Returns `{ success: true, driveChanges: { social: 10 } }` and updates the relationship (trust +5, familiarity +3).
    - `ignore`: Returns `{ success: true, driveChanges: { social: -5 } }` and updates the relationship (trust -2, familiarity +1).

28. **Social affordance resolution in Execute phase** — Modify `ExecuteDataProviderImpl.resolveAffordance` to check if the affordance ID starts with `talk_to_`, `observe_agent_`, `help_`, or `ignore_`. If so, extract the target agent ID from the suffix. Verify the target agent is in the same room as the acting agent (via `agentManager.getState`). Return `{ objectId: targetAgentId, affordance: <the social affordance> }`. If the target agent is not in the same room, return `null` (the affordance is no longer valid — the target may have moved).

29. **`AgentManagerImpl.spawn` — initialize relationships** — When spawning an agent, initialize `state.relationships = {}` (empty `RelationshipMap`). This ensures the field is always present on spawned agents.

### Cognition Layer (`@evol-hive/cognition`)

30. **Perception builder — agent presence injection** — In `PerceptionBuilderImpl.build()` (`packages/cognition/src/pper/perception-builder.ts`), when `perceptionResult.passive.agentsPresent` is present and non-empty, append a context line:
    ```
    Agents present: <name1> (<activity1>), <name2> (<activity2>), ...
    ```
    Include `isThinking` indicator: if an agent is thinking, append "(thinking)" after their name. Example: `"Agents present: Bob (brewing coffee), Carol (thinking)"`.

31. **Perception builder — social context injection** — In `PerceptionBuilderImpl.build()`, when `perceptionResult.passive.socialContext` is present and non-empty, append context lines for each message:
    ```
    <fromAgentName> says: "<content>"
    ```
    These appear after the agents-present line and before the drives summary.

32. **Perception builder — relationship context injection** — In `PerceptionBuilderImpl.build()`, when `perceptionResult.relationships` is present (new optional field on `PerceptionResult`), append a context line for each known agent in the room:
    ```
    You know <name> — trust: <trustLabel>, familiarity: <familiarityLabel>
    ```
    Where `trustLabel` is "high" (>50), "moderate" (20–50), "low" (-20–20), "distrustful" (-50 to -20), or "deeply distrustful" (<-50). `familiarityLabel` is "well" (>50), "somewhat" (20–50), or "barely" (<20). Only include agents that are currently in the room (cross-reference with `agentsPresent`).

33. **`relationships` on `PerceptionResult`** — Add an optional field `relationships?: RelationshipMap` to `PerceptionResult` in `packages/shared/src/types/cognition.ts`. Populated by the perception service from `PerceptionDataProvider.getRelationships`.

34. **Perception builder — social affordances in available actions** — In `PerceptionBuilderImpl.build()`, when `perceptionResult.socialAffordances` is present and non-empty, append them to `availableAffordances` in the returned `LLMContextPayload` (concatenated with `prunedAffordances`). This ensures the LLM sees both physical and social affordances as choosable actions.

35. **Plan builder — social context injection** — In `PlanBuilderImpl.build()` (`packages/cognition/src/pper/plan-builder.ts`), apply the same agent-presence, social-context, and relationship context injections as the perception builder (Reqs 30–32). This ensures the LLM has social context when formulating plans.

36. **Plan builder — social affordances** — In `PlanBuilderImpl.build()`, when `perceptionResult.socialAffordances` is present, append them to `availableAffordances` (same as Req 34).

37. **`CognitiveToolExecutorImpl` — `executeTalkTo`** — Add an `executeTalkTo(agentId, targetAgentId, message)` method to `CognitiveToolExecutorImpl` in `packages/cognition/src/tools/cognitive-tool-executor.ts`. The method:
    - Checks that `executeDataProvider.enqueueMessage` is available (the executor needs an `ExecuteDataProvider` reference — add `executeDataProvider?: ExecuteDataProvider` to `CognitiveToolExecutorOptions`). If not available, returns `{ success: false, targetAgentId, message: '', failureReason: 'Communication not available.' }`.
    - Calls `enqueueMessage(agentId, targetAgentId, message)`. If it returns `false`, returns `{ success: false, targetAgentId, message, failureReason: 'Target agent not found or not in range.' }`.
    - Calls `updateRelationship(agentId, targetAgentId, { trust: +2, familiarity: +5, lastInteraction: <sim time> })` (when available).
    - Calls `updateRelationship(targetAgentId, agentId, { familiarity: +3, lastInteraction: <sim time> })` (when available — the target also gains familiarity).
    - Returns `{ success: true, targetAgentId, message }`.

38. **`talk_to` tool definition in default catalog** — Add the `talk_to` `CognitiveTool` to `defaultCognitiveTools` in `packages/cognition/src/tools/index.ts` (as specified in Req 15). Update `cognitiveToolsToToolDefinitions` to include it automatically (it already maps all entries in the array).

39. **Perception service — populate social fields** — The perception service (or orchestrator's Perceive phase) must call `PerceptionDataProvider.getAgentsInRoom`, `getPendingMessages`, and `getRelationships` (when available) and populate `PassivePerception.agentsPresent`, `PassivePerception.socialContext`, `PerceptionResult.socialAffordances`, and `PerceptionResult.relationships`. When the methods are not available (optional interface methods), the fields are left `undefined`. The `socialAffordances` are generated via `generateSocialAffordances(agentsPresent)` (Req 26).

40. **Social drive modification on interaction** — The `talk_to`, `help`, and `ignore` affordance handlers return `driveChanges` that modify the `social` drive (Req 27). The Execute phase already applies `driveChanges` via `dataProvider.applyDriveChanges`. No additional wiring is needed — the existing flow handles it.

### Tests (`packages/engine/tests/multi-agent-social.test.ts` and `packages/cognition/tests/multi-agent-social.test.ts`)

41. **Agent perception test** — Spawn two agents (Alice, Bob) in the same room. Call `perceptionDataProvider.getAgentsInRoom(roomId, aliceId)`. Assert the result contains one `AgentSummary` with `agentId: bobId`, `name: "Bob"`, `currentActivity: "idle"`, `isThinking: false`. Set Bob's `isThinking` to `true` and assert the summary reflects it.

42. **Message queue test** — Enqueue a message from Alice to Bob. Assert `messageQueue.peek(bobId)` returns one message with `fromAgentId: aliceId`, `content: "Hello"`. Assert `messageQueue.dequeueAll(bobId)` returns the message and `peek(bobId)` returns `[]` (queue is drained).

43. **Message enqueue via ExecuteDataProvider test** — Call `executeDataProvider.enqueueMessage(aliceId, bobId, "Hi there")`. Assert `messageQueue.peek(bobId)` has one message with `fromAgentName: "Alice"`. Call `enqueueMessage(aliceId, "nonexistent", "test")` and assert it returns `false`.

44. **Relationship update test** — Call `executeDataProvider.updateRelationship(aliceId, bobId, { trust: 10, familiarity: 5 })`. Assert `agentManager.getState(aliceId).relationships[bobId]` has `trust: 10, familiarity: 5`. Call `updateRelationship(aliceId, bobId, { trust: 200 })` and assert `trust` is clamped to `100`. Call `updateRelationship(aliceId, bobId, { trust: -200 })` and assert `trust` is clamped to `-100`.

45. **Social affordance generation test** — Call `generateSocialAffordances([{ agentId: "bob", name: "Bob", currentActivity: "idle", isThinking: false }])`. Assert the result has 4 affordances: `talk_to_bob`, `observe_agent_bob`, `help_bob`, `ignore_bob`. Assert each has the correct `engineEffect`, `label`, and `effects` per Req 26.

46. **Social affordance resolution test** — Place Alice and Bob in the same room. Call `executeDataProvider.resolveAffordance(roomId, "talk_to_bob")`. Assert it returns `{ objectId: "bob", affordance: <Affordance with id "talk_to_bob"> }`. Move Bob to a different room. Call `resolveAffordance(roomId, "talk_to_bob")` again and assert it returns `null`.

47. **`talk_to` cognitive tool execution test** — Wire `CognitiveToolExecutorImpl` with an `ExecuteDataProvider` that has `enqueueMessage` and `updateRelationship`. Call `executeTalkTo(aliceId, bobId, "Hello Bob")`. Assert the result is `{ success: true, targetAgentId: "bob", message: "Hello Bob" }`. Assert `messageQueue.peek(bobId)` has one message from Alice. Assert Alice's relationship with Bob has `familiarity >= 5` and `trust >= 2`. Assert Bob's relationship with Alice has `familiarity >= 3`.

48. **Perception builder social context test** — Construct a `PerceptionResult` with `passive.agentsPresent` containing Bob (activity "brewing coffee", isThinking false) and `passive.socialContext` containing one message from Bob ("Hey Alice"). Call `perceptionBuilder.build(perceptionResult)`. Assert the `perceptionContext` string contains `"Agents present: Bob (brewing coffee)"` and `"Bob says: \"Hey Alice\""`.

49. **Perception builder relationship context test** — Construct a `PerceptionResult` with `agentsPresent` containing Bob and `relationships` containing `{ bob: { trust: 60, familiarity: 70, lastInteraction: 100 } }`. Call `perceptionBuilder.build(perceptionResult)`. Assert the `perceptionContext` contains `"You know Bob — trust: high, familiarity: well"`.

50. **Perception builder social affordances test** — Construct a `PerceptionResult` with `socialAffordances` containing `talk_to_bob` and `prunedAffordances` containing `brew_coffee`. Call `perceptionBuilder.build(perceptionResult)`. Assert `availableAffordances` in the result contains both `talk_to_bob` and `brew_coffee`.

51. **Social drive decay test** — Spawn an agent with `social: 50`. Call `driveSystem.applyDecay(state, 10)`. Assert `state.drives.social` is `40`. Call `driveSystem.applyChanges(agentId, { social: 20 })`. Assert `state.drives.social` is `60`.

52. **Social drive as primary drive test** — Spawn an agent with `energy: 80, hunger: 80, social: 10, comfort: 80, curiosity: 80`. Call `driveSystem.getPrimaryDriveLabel(state)`. Assert the label contains "social". This confirms the social drive can be the primary drive without any changes to `DriveSystem`.

53. **End-to-end social interaction test** — Set up a minimal scene with two agents in the same room. Run one PPER cycle for Alice with a mock LLM that calls `talk_to` targeting Bob with message "Hello". Assert Bob's message queue receives the message. Run one PPER cycle for Bob and assert the perception context includes the message from Alice. Assert Alice's relationship with Bob has been updated (familiarity > 0).

54. **Agent not in room — social affordance absent test** — Spawn Alice and Bob in different rooms. Call `perceptionDataProvider.getAgentsInRoom(aliceRoom, aliceId)`. Assert the result is `[]`. Assert `generateSocialAffordances([])` returns `[]`. Verify the perception builder does not add an "Agents present" line when `agentsPresent` is `undefined`.

## Acceptance Criteria

- [ ] **AC-1**: `AgentSummary` interface exists in `packages/shared/src/types/agent.ts` with fields `agentId: string`, `name: string`, `currentActivity: string`, `isThinking: boolean`. *(Req 1)*
- [ ] **AC-2**: `SocialMessage` interface exists in `packages/shared/src/types/agent.ts` with fields `fromAgentId: string`, `fromAgentName: string`, `content: string`, `timestamp: number`. *(Req 2)*
- [ ] **AC-3**: `RelationshipEntry` interface exists in `packages/shared/src/types/agent.ts` with fields `trust: number`, `familiarity: number`, `lastInteraction: number`. `RelationshipMap` type is `Record<string, RelationshipEntry>`. *(Req 3, 4)*
- [ ] **AC-4**: `AgentInternalState` in `packages/shared/src/types/agent.ts` has optional field `relationships?: RelationshipMap`. After `agentManager.spawn(profile)`, `state.relationships` is `{}` (empty map). *(Req 5, 29)*
- [ ] **AC-5**: `PassivePerception` in `packages/shared/src/types/cognition.ts` has optional fields `agentsPresent?: AgentSummary[]` and `socialContext?: SocialMessage[]`. *(Req 6, 7)*
- [ ] **AC-6**: `PerceptionResult` in `packages/shared/src/types/cognition.ts` has optional fields `socialAffordances?: Affordance[]` and `relationships?: RelationshipMap`. *(Req 8, 33)*
- [ ] **AC-7**: `PerceptionDataProvider` interface has optional methods `getAgentsInRoom?(roomId, excludeAgentId?): AgentSummary[]`, `getPendingMessages?(agentId): SocialMessage[]`, `getRelationships?(agentId): RelationshipMap | undefined`. *(Req 9, 10, 11)*
- [ ] **AC-8**: `ExecuteDataProvider` interface has optional methods `enqueueMessage?(fromAgentId, toAgentId, content): boolean`, `updateRelationship?(agentId, targetAgentId, updates): void`, `getAgentName?(agentId): string | null`. *(Req 12, 13, 14)*
- [ ] **AC-9**: `CognitiveToolName` includes `'talk_to'`. `TalkToToolResult` interface exists with `success: boolean`, `targetAgentId: string`, `message: string`, `failureReason?: string`. `CognitiveToolExecutor` interface has method `executeTalkTo(agentId, targetAgentId, message): Promise<TalkToToolResult>`. *(Req 15, 16, 17)*
- [ ] **AC-10**: `MessageQueue` class exists in `packages/engine/src/agents/messages/index.ts`. `enqueue(toAgentId, message)` returns `false` for unknown agents and `true` for known. `dequeueAll(agentId)` returns all messages and clears the inbox. `peek(agentId)` returns messages without clearing. *(Req 18)*
- [ ] **AC-11**: `EngineCore` in `packages/engine/src/assembly.ts` has `messageQueue: MessageQueue`. It is initialized in `createEngineCore` and wired into `PerceptionDataProviderImpl` and `ExecuteDataProviderImpl`. *(Req 19)*
- [ ] **AC-12**: `PerceptionDataProviderImpl.getAgentsInRoom(roomId, excludeAgentId)` returns `AgentSummary[]` for all agents in the room except the excluded one. `currentActivity` is derived from the current plan step or `"idle"`. `isThinking` reflects the agent's state. *(Req 20, 41)*
- [ ] **AC-13**: `PerceptionDataProviderImpl.getPendingMessages(agentId)` calls `messageQueue.dequeueAll` and returns the result. A second call returns `[]` (queue drained). *(Req 21, 42)*
- [ ] **AC-14**: `PerceptionDataProviderImpl.getRelationships(agentId)` returns `state.relationships` or `undefined`. *(Req 22)*
- [ ] **AC-15**: `ExecuteDataProviderImpl.enqueueMessage(fromAgentId, toAgentId, content)` enqueues a `SocialMessage` with correct `fromAgentName` and returns `true`. Returns `false` for a nonexistent target agent. *(Req 23, 43)*
- [ ] **AC-16**: `ExecuteDataProviderImpl.updateRelationship(agentId, targetAgentId, updates)` creates or updates a `RelationshipEntry`. `trust` is clamped to [-100, 100], `familiarity` to [0, 100]. *(Req 24, 44)*
- [ ] **AC-17**: `ExecuteDataProviderImpl.getAgentName(agentId)` returns the profile name or `null`. *(Req 25)*
- [ ] **AC-18**: `generateSocialAffordances(agentsInRoom)` returns 4 `Affordance` objects per agent: `talk_to_<id>`, `observe_agent_<id>`, `help_<id>`, `ignore_<id>` with correct labels, engineEffects, and effects. Returns `[]` for empty input. *(Req 26, 45, 54)*
- [ ] **AC-19**: Social affordance handlers for `talk_to`, `observe_agent`, `help`, `ignore` are registered in `AffordanceRegistry`. `talk_to` handler returns `driveChanges: { social: 5 }`. `help` handler returns `driveChanges: { social: 10 }` and updates trust +5. `ignore` handler returns `driveChanges: { social: -5 }` and updates trust -2. *(Req 27)*
- [ ] **AC-20**: `ExecuteDataProviderImpl.resolveAffordance(roomId, "talk_to_bob")` returns `{ objectId: "bob", affordance: ... }` when Bob is in the room. Returns `null` when Bob has moved to a different room. *(Req 28, 46)*
- [ ] **AC-21**: `PerceptionBuilderImpl.build()` includes `"Agents present: <name> (<activity>)"` in `perceptionContext` when `agentsPresent` is non-empty. Includes `"(thinking)"` for thinking agents. Omits the line when `agentsPresent` is `undefined`. *(Req 30, 48, 54)*
- [ ] **AC-22**: `PerceptionBuilderImpl.build()` includes `"<fromName> says: \"<content>\""` lines in `perceptionContext` when `socialContext` is non-empty. *(Req 31, 48)*
- [ ] **AC-23**: `PerceptionBuilderImpl.build()` includes `"You know <name> — trust: <label>, familiarity: <label>"` when `relationships` and `agentsPresent` are both populated and the relationship entry exists for an agent in the room. Trust labels: "high" (>50), "moderate" (20–50), "low" (-20–20), "distrustful" (-50 to -20), "deeply distrustful" (<-50). Familiarity labels: "well" (>50), "somewhat" (20–50), "barely" (<20). *(Req 32, 49)*
- [ ] **AC-24**: `PerceptionBuilderImpl.build()` merges `socialAffordances` into `availableAffordances` alongside `prunedAffordances`. *(Req 34, 50)*
- [ ] **AC-25**: `PlanBuilderImpl.build()` includes the same agent-presence, social-context, and relationship context lines as the perception builder. Also merges `socialAffordances` into `availableAffordances`. *(Req 35, 36)*
- [ ] **AC-26**: `CognitiveToolExecutorImpl.executeTalkTo(agentId, targetAgentId, message)` enqueues a message via `ExecuteDataProvider.enqueueMessage`, updates relationships for both agents, and returns `{ success: true, targetAgentId, message }`. Returns `{ success: false, ... }` when the execute data provider is not wired or the target agent doesn't exist. *(Req 37, 47)*
- [ ] **AC-27**: `defaultCognitiveTools` in `packages/cognition/src/tools/index.ts` includes a `talk_to` entry with the correct name, description, and argsSchema. `cognitiveToolsToToolDefinitions` includes it in the output. *(Req 15, 38)*
- [ ] **AC-28**: The perception service populates `PassivePerception.agentsPresent`, `PassivePerception.socialContext`, `PerceptionResult.socialAffordances`, and `PerceptionResult.relationships` by calling the optional `PerceptionDataProvider` methods. When methods are unavailable, fields are `undefined`. *(Req 39)*
- [ ] **AC-29**: `DriveSystem.applyDecay` decays the `social` drive like all other drives. `DriveSystem.applyChanges` modifies the `social` drive. `DriveSystem.getPrimaryDriveLabel` returns a label containing "social" when social is the lowest drive. *(Req 40, 51, 52)*
- [ ] **AC-30**: End-to-end: Alice calls `talk_to(bob, "Hello")` via a mock LLM. Bob's message queue receives the message. On Bob's next Perceive tick, the perception context includes `"Alice says: \"Hello\""`. Alice's relationship with Bob has `familiarity >= 5`. *(Req 53)*

## Constraints

- **Package boundaries** (per ADR-0001): `engine` and `cognition` must not directly import from each other. All cross-package communication flows through bridge interfaces defined in `@evol-hive/shared`. The `MessageQueue` is engine-owned; the cognition layer accesses it only through `PerceptionDataProvider.getPendingMessages` and `ExecuteDataProvider.enqueueMessage`.
- **No new engine systems**: Do not add new `EngineSystem` implementations. The `MessageQueue` is a plain class, not a game-loop system. Social affordance generation happens in the perception data provider, not as a system.
- **Backward compatibility**: All new fields on `PassivePerception`, `PerceptionResult`, `AgentInternalState`, `PerceptionDataProvider`, and `ExecuteDataProvider` are optional. Existing code that doesn't set them continues to compile and run. Existing scenes without multiple agents in the same room produce `agentsPresent: undefined` and no social affordances.
- **No changes to `DriveSystem`**: The social drive already exists in `AgentDrives` and is already decayed by `applyDecay` and modified by `applyChanges`. The `getPrimaryDrive` method already considers it. No changes to `DriveSystem` are needed — the social drive simply needs affordance handlers that modify it (which they do via `driveChanges`).
- **No changes to `AgentProfile.relationships`**: The existing `relationships?: Record<string, string>` on `AgentProfile` is static persona text used by `formatPersona`. The new `RelationshipMap` on `AgentInternalState` is the live, mutable relationship data. Both can coexist — one is persona description, the other is game state.
- **Social affordances are not registered on smart objects**: They are generated dynamically by the perception data provider based on which agents are in the room. They bypass the `SmartObjectRegistry` but are resolved by a special case in `ExecuteDataProviderImpl.resolveAffordance`.
- **Message delivery is next-tick, not instant**: Messages are queued and delivered on the target agent's next Perceive tick. This is by design — agents operate on independent PPER cycles and may not be thinking at the same time.
- **No message history**: The `MessageQueue` only holds undelivered messages. Once consumed by `getPendingMessages`, they are gone. Message persistence (for memory or reflection) is a future concern — agents can store memories of conversations via the existing `Reflect` phase `memoryEntry` mechanism.
- **`talk_to` as both cognitive tool and physical affordance**: The `talk_to` cognitive tool (called during the LLM tool-calling loop) is the primary path. The `talk_to_<agentId>` physical affordance (executed via the Execute phase) is a fallback for when the LLM chooses it as a physical action. Both paths enqueue messages; the cognitive tool path allows the LLM to specify a custom message, while the physical affordance path sends a default message.
- **What NOT to do**:
  - Do not modify the `GameLoop`, `PPERScheduler`, `SpatialSystem`, or `DriveDecaySystem`.
  - Do not add real-time chat or WebSocket communication — this is a simulation, not a multiplayer game.
  - Do not implement agent groups, factions, or social networks — relationship tracking is pairwise only.
  - Do not implement natural language generation for agent responses — the LLM handles dialogue generation via tool calls.
  - Do not add visual rendering, UI, or a chat interface.
  - Do not add new npm dependencies.
  - Do not modify the `formatPersona` function — it already handles `AgentProfile.relationships` (static text). The new `RelationshipMap` on `AgentInternalState` is injected separately by the perception builder.
  - Do not change the `AffordanceHandler` signature or `PhysicsSystemImpl` — social affordance handlers use the same signature as physical affordance handlers.
