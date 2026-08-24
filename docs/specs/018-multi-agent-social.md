# Feature: Multi-Agent Social — Agent-to-Agent Perception, Communication, Relationships, Social Drives

## Context
- Architecture: [§3 — Agent State Schema](../architecture/03-agent-state-schema.md) (AgentInternalState, AgentDrives, AgentProfile), [§6 — PPER Loop](../architecture/06-pper-loop.md) (Perceive phase, passive perception, spatial debouncing), [§8 — Cognitive Tools](../architecture/08-cognitive-tools.md) (intrinsic tools, tool calling, mid-loop execution), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md) (Affordance type, effects on drives)
- Related specs: [001 — Perceive Phase](001-perceive-phase.md) (PassivePerception, PerceptionResult, PerceptionDataProvider, PerceptionServiceImpl), [002 — Plan Phase](002-plan-phase.md) (PlanBuilderImpl, PlanServiceImpl), [012 — Agent Persona System](012-agent-persona-system.md) (AgentProfile.relationships, formatPersona), [013 — Richer Prototype Scenes](013-richer-prototype-scenes.md) (multi-agent scenes, social affordance objects, social drive in scenes), [015 — Full Cognitive Tools](015-full-cognitive-tools.md) (CognitiveToolExecutor, tool call loop, COGNITIVE_TOOL_NAMES, mid-loop vs terminal tools), [016 — Cognitive Guardrails](016-cognitive-guardrails.md) (affordance masking, contextual forcing)
- Package: `shared` (new social types, bridge interfaces, tool schemas, PerceptionDataProvider extensions, CognitiveToolExecutor extensions), `engine` (SocialManager, MessageQueue, PerceptionDataProviderImpl extensions, AgentManager relationship storage), `cognition` (CognitiveToolExecutorImpl social methods, builder social context injection, COGNITIVE_TOOL_NAMES update, tool call loop social tool handling)
- ADR: [ADR-0001 — Lean Monorepo Structure](../adr/0001-lean-monorepo-structure.md)
- Issue: [#62](https://github.com/Redna/evol-hive/issues/62)

## Design Rationale

Agents coexist in the same world but are socially isolated. The `PassivePerception` only includes objects, not other agents. The `social` drive exists in `AgentDrives` but has no behavioral outlet beyond object-based affordances (e.g., `small_talk` on a Water Cooler). `AgentProfile.relationships` is a simple `Record<string, string>` for prompt context — there is no structured relationship tracking, no inter-agent communication, and no dynamic social actions.

This spec introduces four capabilities that build on the existing PPER loop and cognitive tool infrastructure:

1. **Agent-to-agent perception** — Other agents in the same room appear in `PassivePerception.agentsPresent` as `AgentSummary` objects. The perception builder includes them in the LLM context so the LLM knows who else is present.

2. **Social cognitive tools** — Four new cognitive tools (`talk_to`, `observe_agent`, `help`, `ignore`) are defined as mid-loop tools (executed and fed back to the LLM, like `query_memory` and `update_internal_state` from spec 015). They take a `targetAgentId` parameter. They are conditionally included in the `tools` array only when other agents are present (via `PassivePerception.agentsPresent`). This avoids the mismatch between physical affordances (which target smart objects via `resolveAffordance`) and social actions (which target other agents). All four are cognitive tools rather than physical affordances because (a) `talk_to` requires a message argument that the affordance system cannot express, (b) `observe_agent` returns agent state that doesn't fit `AffordanceResult.newState`, and (c) the cognitive tool execution loop (spec 015) already provides the mid-loop execution pattern.

3. **Inter-agent communication** — `talk_to(targetAgentId, message)` queues a `SocialMessage` for the target agent. On the target's next Perceive tick, the message appears in `PassivePerception.socialContext`. This enables emergent dialogue: agent A talks to B → B sees the message on next tick → B can respond by calling `talk_to(A, response)`.

4. **Structured relationship tracking** — `AgentInternalState.relationships` is a `Record<string, Relationship>` where `Relationship = { trust, familiarity, lastInteraction }`. Trust and familiarity (0–100) are updated by social interactions. The perception builder converts structured relationships into natural-language context for the LLM ("You know Bob well and trust him"). The existing `AgentProfile.relationships` (string map) continues to provide static prompt context via `formatPersona`; the new structured data provides dynamic, evolving relationship state.

5. **Social drive behavior** — The `social` drive (0–100, 0 = most urgent) already exists. Social interactions boost it: `talk_to` applies `social: +10`, `help` applies `social: +15`. When social is the primary drive and other agents are present, the builder injects a prompt hint encouraging social interaction. When social is high (satisfied), it is not the primary drive and the LLM naturally focuses on other needs. No new drive system logic is needed — the existing `DriveSystem` and `getPrimaryDriveLabel` handle this.

The design follows existing patterns: bridge interfaces in `shared` (like `PerceptionDataProvider`, `CognitiveToolExecutor`), engine implementations (like `PerceptionDataProviderImpl`), cognition layer consumption (like `PerceptionServiceImpl`, `PerceptionBuilderImpl`), and the tool call loop from spec 015. No new `EngineSystem` implementations are needed — the `SocialManager` is a passive data structure, not a ticked system.

## Requirements

### Shared Layer (`@evol-hive/shared`)

1. **`AgentSummary` type** — A new type must be defined in `packages/shared/src/types/cognition.ts`:
   ```typescript
   interface AgentSummary {
     agentId: string;
     name: string;
     currentActivity: string;
     isThinking: boolean;
   }
   ```
   `currentActivity` is a short string derived from the agent's state: `"thinking"` when `isThinking` is true, `"working on: <plan.description>"` when the agent has an active plan, `"idle"` otherwise. This type is used in `PassivePerception.agentsPresent` and in `observe_agent` tool results.

2. **`SocialMessage` type** — A new type must be defined in `packages/shared/src/types/cognition.ts`:
   ```typescript
   interface SocialMessage {
     fromAgentId: string;
     fromName: string;
     content: string;
     timestamp: number;
   }
   ```
   `fromName` is included so the perceiving agent knows who sent the message without an additional lookup. `timestamp` is the simulation time when the message was queued.

3. **`Relationship` type** — A new type must be defined in `packages/shared/src/types/agent.ts`:
   ```typescript
   interface Relationship {
     trust: number;       // 0–100, 50 = neutral
     familiarity: number; // 0–100, 0 = strangers
     lastInteraction: number; // simulation timestamp
   }
   ```
   Trust and familiarity are clamped to 0–100. `lastInteraction` is the simulation time of the most recent social interaction between the two agents.

4. **`SocialToolResult` type** — A new type must be defined in `packages/shared/src/types/cognition.ts`:
   ```typescript
   interface SocialToolResult {
     success: boolean;
     message: string;
     relationshipUpdated: boolean;
     /** Present only for observe_agent: the observed agent's details. */
     observedAgent?: { name: string; currentActivity: string; isThinking: boolean; drives: Record<string, number> };
   }
   ```
   The `message` field is a human-readable confirmation sent back to the LLM as the tool result content. `observedAgent` is populated only by `observe_agent` and includes the target agent's drives for the LLM's reference.

5. **`agentsPresent` on `PassivePerception`** — The `PassivePerception` interface must be extended with an optional field:
   ```typescript
   agentsPresent?: AgentSummary[];
   ```
   This is populated by `PassivePerceptionAssembler` during the Perceive phase. It lists other agents in the same room (excluding the perceiving agent). When no other agents are present, the field is `undefined` (not an empty array) to minimize token usage.

6. **`socialContext` on `PassivePerception`** — The `PassivePerception` interface must be extended with an optional field:
   ```typescript
   socialContext?: SocialMessage[];
   ```
   This is populated by `PassivePerceptionAssembler` by dequeuing pending social messages. Messages are consumed (removed from the queue) when read. When no messages are pending, the field is `undefined`.

7. **`relationships` on `AgentInternalState`** — The `AgentInternalState` interface must be extended with an optional field:
   ```typescript
   relationships?: Record<string, Relationship>;
   ```
   This is a map from other agent IDs to structured relationship data. It is populated at spawn time from `AgentProfile.relationships` (seed values) and updated by social interactions. When the agent has no relationships, the field is `undefined`.

8. **`targetAgentId` on `Affordance`** — The `Affordance` interface must be extended with an optional field:
   ```typescript
   targetAgentId?: string;
   ```
   This field is reserved for future use when social affordances are implemented as physical affordances. In this spec, social actions are cognitive tools, so this field is not populated by the current implementation. It is added to the type for forward compatibility and to document the intent that affordances can target agents.

9. **`PerceptionDataProvider` extensions** — The `PerceptionDataProvider` interface must be extended with three new optional methods (all optional for backward compatibility with existing mock implementations):
   ```typescript
   getAgentsInRoom?(roomId: string, excludingAgentId: string): AgentSummary[];
   dequeueSocialMessages?(agentId: string): SocialMessage[];
   getRelationships?(agentId: string): Record<string, Relationship>;
   ```
   `getAgentsInRoom` returns summaries of all agents in the room except the excluding agent. `dequeueSocialMessages` returns and consumes pending social messages for the agent. `getRelationships` returns the agent's structured relationship map. When a provider does not implement these methods, the perception service must handle their absence gracefully (set the corresponding `PassivePerception` fields to `undefined`).

10. **`SocialActionBridge` interface** — A new bridge interface must be defined in `packages/shared/src/types/cognition.ts` for social action execution (used by `CognitiveToolExecutorImpl`):
    ```typescript
    interface SocialActionBridge {
      queueMessage(fromAgentId: string, toAgentId: string, content: string): void;
      updateRelationship(agentId: string, otherAgentId: string, updates: Partial<Relationship>): void;
      getAgentSummary(agentId: string): AgentSummary | null;
      getAgentDrives(agentId: string): Record<string, number>;
    }
    ```
    This interface is defined in `shared` because both `cognition` (consumer — `CognitiveToolExecutorImpl`) and the application entry point (provider — wires the engine implementation) need to reference it. Per ADR-0001, `cognition` can import from `shared`.

11. **`CognitiveToolExecutor` interface extensions** — The `CognitiveToolExecutor` interface (spec 015, Req 1) must be extended with four new methods:
    ```typescript
    executeTalkTo(agentId: string, targetAgentId: string, message: string): Promise<SocialToolResult>;
    executeObserveAgent(agentId: string, targetAgentId: string): Promise<SocialToolResult>;
    executeHelp(agentId: string, targetAgentId: string): Promise<SocialToolResult>;
    executeIgnore(agentId: string, targetAgentId: string): Promise<SocialToolResult>;
    ```
    These methods are called by the LLM client's tool call loop when the LLM invokes the corresponding social tool. Each returns a `SocialToolResult` that is sent back to the LLM as the tool result content.

12. **`CognitiveToolName` extension** — The `CognitiveToolName` type must be extended:
    ```typescript
    type CognitiveToolName = 'formulate_plan' | 'query_memory' | 'update_internal_state' | 'talk_to' | 'observe_agent' | 'help' | 'ignore';
    ```

13. **Social tool schemas** — Four new JSON schemas must be defined in `packages/shared/src/schemas/llm-schemas.ts`:
    - `talkToSchema` — `{ type: 'object', properties: { targetAgentId: { type: 'string', description: '...' }, message: { type: 'string', description: '...' } }, required: ['targetAgentId', 'message'], additionalProperties: false }`
    - `observeAgentSchema` — `{ type: 'object', properties: { targetAgentId: { type: 'string', description: '...' } }, required: ['targetAgentId'], additionalProperties: false }`
    - `helpSchema` — `{ type: 'object', properties: { targetAgentId: { type: 'string', description: '...' } }, required: ['targetAgentId'], additionalProperties: false }`
    - `ignoreSchema` — `{ type: 'object', properties: { targetAgentId: { type: 'string', description: '...' } }, required: ['targetAgentId'], additionalProperties: false }`

14. **Social tool definition constants** — Four new `ToolDefinition` constants must be exported from `packages/shared/src/schemas/llm-schemas.ts`:
    - `talkToTool` — name `'talk_to'`, description `'Send a message to another agent in the same room. The message will appear in their next perception tick.'`
    - `observeAgentTool` — name `'observe_agent'`, description `'Observe another agent in the same room. Returns their current activity, drives, and state.'`
    - `helpTool` — name `'help'`, description `'Help another agent in the same room. Boosts their primary drive and your social drive.'`
    - `ignoreTool` — name `'ignore'`, description `'Choose to ignore another agent in the same room. Signals social disengagement.'`
    These follow the same pattern as `formulatePlanTool`, `queryMemoryTool`, `updateInternalStateTool` (spec 015, Req 7).

15. **`defaultCognitiveTools` extension** — The `defaultCognitiveTools` array in `packages/cognition/src/tools/index.ts` must be extended with four new entries for `talk_to`, `observe_agent`, `help`, and `ignore`. Each entry's `argsSchema` must match the corresponding schema from Req 13. This keeps the `CognitiveTool` metadata in sync with the `ToolDefinition` constants.

### Engine Layer (`@evol-hive/engine`)

16. **`MessageQueue` class** — A new class must be implemented in `packages/engine/src/social/message-queue.ts` that manages an in-memory `Map<string, SocialMessage[]>`:
    - `enqueue(toAgentId: string, message: SocialMessage): void` — appends to the agent's queue
    - `dequeue(agentId: string): SocialMessage[]` — returns all pending messages and clears the queue. Returns `[]` when no messages are pending.
    - `pendingCount(agentId: string): number` — returns the number of pending messages (for debugging/testing)

17. **`SocialManager` class** — A new class must be implemented in `packages/engine/src/social/social-manager.ts` that implements `SocialActionBridge`. It is constructed with `AgentManager` and `SceneManager` references:
    - `queueMessage(fromAgentId, toAgentId, content)` — constructs a `SocialMessage` with `fromName` (looked up from `AgentManager.getProfile(fromAgentId)?.name ?? fromAgentId`) and the current simulation time, then calls `messageQueue.enqueue(toAgentId, message)`.
    - `updateRelationship(agentId, otherAgentId, updates)` — reads `AgentInternalState.relationships` (or initializes `{}`), looks up or creates the entry for `otherAgentId` (defaults: `trust: 50, familiarity: 0, lastInteraction: 0`), merges the `updates` (clamping trust and familiarity to 0–100), and writes back via `AgentManager.updateState`.
    - `getAgentSummary(agentId)` — reads `AgentInternalState` and `AgentProfile`, returns `AgentSummary` with `name` from profile, `currentActivity` derived from state (see Req 1), and `isThinking` from state. Returns `null` if the agent does not exist.
    - `getAgentDrives(agentId)` — reads `AgentInternalState.drives` and returns them as `Record<string, number>`. Returns `{}` if the agent does not exist.

18. **`getAgentsInRoom` on `SocialManager`** — The `SocialManager` must also provide a method `getAgentsInRoom(roomId: string, excludingAgentId: string): AgentSummary[]` that iterates over `AgentManager.getActiveAgents()`, filters by `state.location === roomId` and `state.agentId !== excludingAgentId`, and returns `AgentSummary[]` via `getAgentSummary` for each. This is used by `PerceptionDataProviderImpl` to implement the `getAgentsInRoom` method on `PerceptionDataProvider`.

19. **`dequeueSocialMessages` on `SocialManager`** — The `SocialManager` must provide `dequeueSocialMessages(agentId: string): SocialMessage[]` that delegates to `MessageQueue.dequeue`. This is used by `PerceptionDataProviderImpl`.

20. **`getRelationships` on `SocialManager`** — The `SocialManager` must provide `getRelationships(agentId: string): Record<string, Relationship>` that reads `AgentInternalState.relationships` or returns `{}` when not set. This is used by `PerceptionDataProviderImpl`.

21. **`PerceptionDataProviderImpl` extensions** — The `PerceptionDataProviderImpl` in `packages/engine/src/agents/perception/` must implement the three new `PerceptionDataProvider` methods (Req 9) by delegating to `SocialManager`. The `SocialManager` is injected via constructor or a setter method. When `SocialManager` is not wired (e.g., minimal test setups), the methods return empty results: `getAgentsInRoom` returns `[]`, `dequeueSocialMessages` returns `[]`, `getRelationships` returns `{}`.

22. **`AgentManagerImpl` relationship seeding** — The `AgentManagerImpl.spawn(profile)` method must seed `AgentInternalState.relationships` from `AgentProfile.relationships` when the profile has entries. For each key in `profile.relationships`, create a `Relationship` with `{ trust: 50, familiarity: 0, lastInteraction: 0 }`. When `profile.relationships` is absent or empty, `relationships` is not set (remains `undefined`). This allows scenes to pre-define relationship context (e.g., Alice and Bob are "trusted colleagues") while the structured data starts at neutral trust and zero familiarity.

23. **Export `SocialManager` and `MessageQueue`** — Both classes must be exported from `packages/engine/src/index.ts` so the application entry point can wire them.

### Cognition Layer — Cognitive Tool Executor (`@evol-hive/cognition`)

24. **`CognitiveToolExecutorImpl` social bridge dependency** — The `CognitiveToolExecutorOptions` interface (spec 015, Req 9) must be extended with an optional `socialBridge?: SocialActionBridge` field. When `socialBridge` is not provided, all four social tool methods return `{ success: false, message: 'Social actions not available.', relationshipUpdated: false }` (no error thrown). This is the same graceful-degradation pattern as `memoryInjector` and `stateDataProvider` from spec 015.

25. **`executeTalkTo` method** — The `executeTalkTo(agentId, targetAgentId, message)` method must:
    - If `socialBridge` is not set, return `{ success: false, message: 'Social actions not available.', relationshipUpdated: false }`.
    - Call `socialBridge.queueMessage(agentId, targetAgentId, message)` to queue the message.
    - Call `socialBridge.updateRelationship(agentId, targetAgentId, { familiarity: +5, trust: +2, lastInteraction: <current time> })` to update the sender's relationship. The current time is obtained from the most recent simulation tick (passed via a new optional `currentTick?: number` field on `CognitiveToolExecutorOptions`, defaulting to `Date.now()`).
    - Call `socialBridge.updateRelationship(targetAgentId, agentId, { familiarity: +5, trust: +2, lastInteraction: <current time> })` to update the target's relationship (bidirectional).
    - Apply social drive boost to the sender: if `stateDataProvider` is set, call `stateDataProvider.applyDriveChanges(agentId, { social: 10 })`.
    - Return `{ success: true, message: 'Message sent to <targetName>.', relationshipUpdated: true }`. The target name is looked up via `socialBridge.getAgentSummary(targetAgentId)?.name ?? targetAgentId`.
    - If `queueMessage` or `updateRelationship` throws, catch the error and return `{ success: false, message: 'Failed to send message: <error>.', relationshipUpdated: false }` (do not propagate — a social action failure should not abort the LLM interaction).

26. **`executeObserveAgent` method** — The `executeObserveAgent(agentId, targetAgentId)` method must:
    - If `socialBridge` is not set, return `{ success: false, message: 'Social actions not available.', relationshipUpdated: false }`.
    - Call `socialBridge.getAgentSummary(targetAgentId)` to get the target's summary. If `null`, return `{ success: false, message: 'Agent not found.', relationshipUpdated: false }`.
    - Call `socialBridge.getAgentDrives(targetAgentId)` to get the target's drives.
    - Call `socialBridge.updateRelationship(agentId, targetAgentId, { familiarity: +1, lastInteraction: <current time> })` — observing an agent slightly increases familiarity.
    - Return `{ success: true, message: 'Observed <name>.', relationshipUpdated: true, observedAgent: { name, currentActivity, isThinking, drives } }`.
    - If any call throws, catch and return `{ success: false, message: 'Failed to observe agent: <error>.', relationshipUpdated: false }`.

27. **`executeHelp` method** — The `executeHelp(agentId, targetAgentId)` method must:
    - If `socialBridge` is not set, return `{ success: false, message: 'Social actions not available.', relationshipUpdated: false }`.
    - Call `socialBridge.updateRelationship(agentId, targetAgentId, { familiarity: +10, trust: +5, lastInteraction: <current time> })`.
    - Call `socialBridge.updateRelationship(targetAgentId, agentId, { familiarity: +10, trust: +5, lastInteraction: <current time> })`.
    - Apply social drive boost to the helper: if `stateDataProvider` is set, call `stateDataProvider.applyDriveChanges(agentId, { social: 15 })`.
    - Determine the target's primary drive (lowest value in `socialBridge.getAgentDrives(targetAgentId)`) and apply `+10` to it: if `stateDataProvider` is set, call `stateDataProvider.applyDriveChanges(targetAgentId, { [primaryDrive]: 10 })`.
    - Return `{ success: true, message: 'You helped <name>. Their <primaryDrive> improved.', relationshipUpdated: true }`.
    - If any call throws, catch and return `{ success: false, message: 'Failed to help agent: <error>.', relationshipUpdated: false }`.

28. **`executeIgnore` method** — The `executeIgnore(agentId, targetAgentId)` method must:
    - If `socialBridge` is not set, return `{ success: false, message: 'Social actions not available.', relationshipUpdated: false }`.
    - Call `socialBridge.updateRelationship(agentId, targetAgentId, { familiarity: -2, trust: -1, lastInteraction: <current time> })` — ignoring an agent slightly degrades the relationship.
    - Apply a small social drive decrease to the agent: if `stateDataProvider` is set, call `stateDataProvider.applyDriveChanges(agentId, { social: -5 })`.
    - Return `{ success: true, message: 'You chose to ignore <name>.', relationshipUpdated: true }`.
    - If any call throws, catch and return `{ success: false, message: 'Failed to ignore agent: <error>.', relationshipUpdated: false }`.

### Cognition Layer — LLM Client Tool Call Loop (`@evol-hive/cognition`)

29. **`COGNITIVE_TOOL_NAMES` update** — The `COGNITIVE_TOOL_NAMES` constant in `openai-client.ts` (spec 015, Req 14) must be updated to include the four new social tools:
    ```typescript
    const COGNITIVE_TOOL_NAMES = new Set<string>([
      'query_memory', 'update_internal_state',
      'talk_to', 'observe_agent', 'help', 'ignore',
    ]);
    ```
    All four are mid-loop tools — their results are fed back to the LLM, and the loop continues until a terminal tool (`formulate_plan`, `choose_action`, `reflect`) is called.

30. **Social tool execution in the tool call loop** — The `sendRequest` method's tool call loop (spec 015, Req 15) must handle the four new social tools. When the LLM calls a social tool:
    - Parse `function.arguments` as JSON.
    - Extract `targetAgentId` (and `message` for `talk_to`).
    - Execute via `cognitiveToolExecutor`:
      - `talk_to`: call `executeTalkTo(agentId, args.targetAgentId, args.message)`.
      - `observe_agent`: call `executeObserveAgent(agentId, args.targetAgentId)`.
      - `help`: call `executeHelp(agentId, args.targetAgentId)`.
      - `ignore`: call `executeIgnore(agentId, args.targetAgentId)`.
    - Construct a tool result message: `{ role: 'tool', content: JSON.stringify(result), tool_call_id: toolCallId }`.
    - Append the assistant message and tool result to the messages array, increment the iteration counter, and send another request (same as the existing `query_memory` and `update_internal_state` handling).
    - If `cognitiveToolExecutor` is not set or `agentId` is not available, the loop falls back to single-request behavior (existing behavior — no social tool execution).

31. **`SocialToolResult` JSON serialization** — The `SocialToolResult` returned by the executor must be serialized as JSON and sent as the `content` of the tool result message. The LLM receives the full result (including `observedAgent` for `observe_agent`) and can use it to inform its next action.

### Cognition Layer — Perception Service & Builder Updates (`@evol-hive/cognition`)

32. **`PassivePerceptionAssembler` social context** — The `PassivePerceptionAssembler.buildPassivePerception(agentId)` method must:
    - Call `provider.getAgentsInRoom?.(roomId, agentId)` to get other agents in the room. If the method is not available or returns `[]`, `agentsPresent` is not set (remains `undefined`).
    - Call `provider.dequeueSocialMessages?.(agentId)` to get pending social messages. If the method is not available or returns `[]`, `socialContext` is not set.
    - Include `agentsPresent` and `socialContext` in the `PassivePerception` object when they have values.

33. **`PerceptionServiceImpl` social affordances** — The `PerceptionServiceImpl.perceive(agentId)` method must:
    - After building the `PassivePerception` (which now includes `agentsPresent`), check if `passive.agentsPresent` is non-empty.
    - If other agents are present, the social tools (`talkToTool`, `observeAgentTool`, `helpTool`, `ignoreTool`) are available to the builder. The service does not add them to `prunedAffordances` — they are cognitive tools, not affordances. The service's role is to ensure `agentsPresent` is populated; the builder conditionally includes the social tool definitions.
    - No changes to the classifier pruning flow — social tools are not affordances and do not go through the classifier.

34. **`PerceptionBuilderImpl` social context injection** — The `PerceptionBuilderImpl.build(perceptionResult)` method must:
    - When `perceptionResult.passive.agentsPresent` is non-empty, add a context line: `"Agents present: <name1> (<activity1>), <name2> (<activity2>), ..."`.
    - When `perceptionResult.passive.socialContext` is non-empty, add a context line for each message: `"Message from <fromName>: \"<content>\""`.
    - When `perceptionResult.passive.agentsPresent` is non-empty, include the social tool definitions (`talkToTool`, `observeAgentTool`, `helpTool`, `ignoreTool`) in the `tools` array alongside the existing tools (`chooseActionTool`, `queryMemoryTool`, `updateInternalStateTool`).
    - When `agentsPresent` is empty/undefined, the social tools are NOT included in the `tools` array (existing behavior preserved).

35. **`PerceptionBuilderImpl` relationship context** — The `PerceptionBuilderImpl` must include relationship context in `perceptionContext` when the agent has structured relationships and other agents are present. For each agent in `agentsPresent` that has a relationship entry, add a context line based on trust and familiarity levels:
    - Trust > 70: `"You trust <name> deeply"`
    - Trust 55–70: `"You know <name> well and trust them"`
    - Trust 45–55 (neutral): `"You are neutral about <name>"`
    - Trust 30–45: `"You distrust <name>"`
    - Trust < 30: `"You deeply distrust <name>"`
    - Familiarity > 60: `"You know <name> very well"`
    - Familiarity 30–60: `"You know <name> somewhat"`
    - Familiarity < 30: `"You barely know <name>"`
    The relationship data is obtained from `perceptionResult.passive` — the service must include a `relationships` field on `PerceptionResult` or the builder must have access to the provider. To keep the builder pure (no provider dependency), the `PerceptionResult` must be extended with an optional `relationships?: Record<string, Relationship>` field, populated by `PerceptionServiceImpl` via `provider.getRelationships?.(agentId)`.

36. **`PerceptionResult.relationships` field** — The `PerceptionResult` interface must be extended with an optional field:
    ```typescript
    relationships?: Record<string, Relationship>;
    ```
    This is populated by `PerceptionServiceImpl` during the Perceive phase by calling `provider.getRelationships?.(agentId)`. When the provider does not implement `getRelationships` or the agent has no relationships, the field is `undefined`. The builders read this field to construct relationship context lines.

37. **`PerceptionServiceImpl` populates `relationships`** — The `PerceptionServiceImpl.perceive(agentId)` method must call `provider.getRelationships?.(agentId)` and include the result in the `PerceptionResult`. If the method is not available, `relationships` is `undefined`. This follows the same graceful-degradation pattern as `persona` (spec 012, Req 11).

38. **`PlanBuilderImpl` social context injection** — The `PlanBuilderImpl.build(perceptionResult)` method must:
    - When `perceptionResult.passive.agentsPresent` is non-empty, add context lines for agents present and social messages (same format as Req 34).
    - When `perceptionResult.relationships` has entries for agents in `agentsPresent`, add relationship context lines (same format as Req 35).
    - When `perceptionResult.passive.agentsPresent` is non-empty, include the social tool definitions in the `tools` array alongside `formulatePlanTool`, `queryMemoryTool`, `updateInternalStateTool`.

39. **Social drive prompt hint** — When the `primaryDriveLabel` contains "social" AND `perceptionResult.passive.agentsPresent` is non-empty, both `PerceptionBuilderImpl` and `PlanBuilderImpl` must append a prompt hint to the context: `"You feel a strong need for social interaction. Consider using talk_to or help to engage with other agents in the room."` This is a prompt-level nudge — it does not change the architecture or the classifier. When the social drive is not the primary drive, this hint is not included.

### Application Entry Point / Assembly

40. **Wiring `SocialManager`** — The application entry point (e.g., `examples/minimal-scene.ts` or scene assembly functions) must construct `SocialManager` with `AgentManager` and `SceneManager` references, inject it into `PerceptionDataProviderImpl` (for perception queries), and pass it as `socialBridge` to `CognitiveToolExecutorImpl` (for social tool execution). When social features are not needed (e.g., minimal test setups), `SocialManager` is not constructed and the social bridge is not wired — the system degrades gracefully (no agents in room, no social messages, no relationship tracking).

41. **`CognitiveToolExecutorOptions.currentTick`** — The `CognitiveToolExecutorOptions` interface must be extended with an optional `currentTick?: number` field. The application entry point can set this to the current simulation tick for accurate `lastInteraction` timestamps. When not set, `Date.now()` is used as a fallback. This field is read-only — it is set at construction time and does not change during the simulation. A more dynamic approach (passing the current tick per call) is a future concern.

### Cross-Cutting

42. **Package boundaries** (per ADR-0001) — All changes are in:
    - `packages/shared/src/types/cognition.ts` (new types: `AgentSummary`, `SocialMessage`, `SocialToolResult`, `SocialActionBridge`; `PerceptionDataProvider` extensions; `CognitiveToolExecutor` extensions; `PassivePerception` extensions; `PerceptionResult.relationships`)
    - `packages/shared/src/types/agent.ts` (new type: `Relationship`; `AgentInternalState.relationships`; `Affordance.targetAgentId`)
    - `packages/shared/src/schemas/llm-schemas.ts` (new schemas: `talkToSchema`, `observeAgentSchema`, `helpSchema`, `ignoreSchema`; new tool constants: `talkToTool`, `observeAgentTool`, `helpTool`, `ignoreTool`)
    - `packages/engine/src/social/` (new directory: `message-queue.ts`, `social-manager.ts`)
    - `packages/engine/src/agents/perception/` (`PerceptionDataProviderImpl` extensions)
    - `packages/engine/src/agents/state/` (`AgentManagerImpl` relationship seeding)
    - `packages/engine/src/index.ts` (export `SocialManager`, `MessageQueue`)
    - `packages/cognition/src/tools/cognitive-tool-executor.ts` (`CognitiveToolExecutorImpl` social methods, `socialBridge` dependency)
    - `packages/cognition/src/tools/index.ts` (`defaultCognitiveTools` extension)
    - `packages/cognition/src/llm/openai-client.ts` (`COGNITIVE_TOOL_NAMES` update, social tool execution in loop)
    - `packages/cognition/src/pper/perception-builder.ts` (social context, social tools, relationship context, social drive hint)
    - `packages/cognition/src/pper/plan-builder.ts` (social context, social tools, relationship context, social drive hint)
    - `packages/cognition/src/pper/index.ts` (`PassivePerceptionAssembler` social context, `PerceptionServiceImpl` relationship population)
    - `docs/specs/INDEX.md` (spec 018 added)
    No new npm dependencies. No changes to `packages/memory/`.

43. **Backward compatibility** — All new `PassivePerception` fields are optional. All new `PerceptionDataProvider` methods are optional. All new `CognitiveToolExecutor` methods are optional (graceful degradation when `socialBridge` is not set). `AgentInternalState.relationships` is optional. `Affordance.targetAgentId` is optional. `PerceptionResult.relationships` is optional. Existing tests, mocks, and scene definitions must compile and pass without modification.

44. **What NOT to do**:
    - Do not implement social affordances as physical affordances on the `AffordanceHandler` / `resolveAffordance` flow — social actions are cognitive tools, not physical affordances.
    - Do not modify the `AffordanceHandler` signature or `PhysicsSystemImpl`.
    - Do not modify the `LLMClient` interface method signatures.
    - Do not modify `packages/memory/`.
    - Do not implement streaming support.
    - Do not add new npm dependencies.
    - Do not implement social affordance masking in the guardrail system — social tools are cognitive tools and are never masked (same as existing cognitive tools, per spec 016).
    - Do not implement agent-to-agent physical interactions (e.g., giving items, blocking paths) — only social interactions (talk, observe, help, ignore).
    - Do not implement relationship decay over time — relationships only change through interactions. Decay is a future concern.
    - Do not implement social context in the Reflect phase — social tools are action-oriented and belong in Perceive and Plan phases only.
    - Do not modify the `DriveDecaySystem` or `DriveSystem` — the social drive uses the existing drive infrastructure unchanged.
    - Do not implement a `SocialSystem` as an `EngineSystem` (ticked system) — `SocialManager` is a passive data structure, not ticked.

## Acceptance Criteria

- [ ] **AC-1**: `AgentSummary` is defined in `packages/shared/src/types/cognition.ts` with `agentId: string`, `name: string`, `currentActivity: string`, `isThinking: boolean`. *(Req 1)*
- [ ] **AC-2**: `SocialMessage` is defined in `packages/shared/src/types/cognition.ts` with `fromAgentId: string`, `fromName: string`, `content: string`, `timestamp: number`. *(Req 2)*
- [ ] **AC-3**: `Relationship` is defined in `packages/shared/src/types/agent.ts` with `trust: number`, `familiarity: number`, `lastInteraction: number`. *(Req 3)*
- [ ] **AC-4**: `SocialToolResult` is defined in `packages/shared/src/types/cognition.ts` with `success: boolean`, `message: string`, `relationshipUpdated: boolean`, and optional `observedAgent?`. *(Req 4)*
- [ ] **AC-5**: `PassivePerception` includes optional field `agentsPresent?: AgentSummary[]`. Existing `PassivePerception` objects without `agentsPresent` compile without error. *(Req 5)*
- [ ] **AC-6**: `PassivePerception` includes optional field `socialContext?: SocialMessage[]`. Existing `PassivePerception` objects without `socialContext` compile without error. *(Req 6)*
- [ ] **AC-7**: `AgentInternalState` includes optional field `relationships?: Record<string, Relationship>`. Existing `AgentInternalState` objects without `relationships` compile without error. *(Req 7)*
- [ ] **AC-8**: `Affordance` includes optional field `targetAgentId?: string`. Existing `Affordance` objects without `targetAgentId` compile without error. *(Req 8)*
- [ ] **AC-9**: `PerceptionDataProvider` includes optional methods `getAgentsInRoom?(roomId, excludingAgentId): AgentSummary[]`, `dequeueSocialMessages?(agentId): SocialMessage[]`, `getRelationships?(agentId): Record<string, Relationship>`. Existing mock providers without these methods compile without error. *(Req 9)*
- [ ] **AC-10**: `SocialActionBridge` is defined in `packages/shared/src/types/cognition.ts` with `queueMessage`, `updateRelationship`, `getAgentSummary`, `getAgentDrives` methods. *(Req 10)*
- [ ] **AC-11**: `CognitiveToolExecutor` interface includes `executeTalkTo`, `executeObserveAgent`, `executeHelp`, `executeIgnore` methods returning `Promise<SocialToolResult>`. *(Req 11)*
- [ ] **AC-12**: `CognitiveToolName` type includes `'talk_to' | 'observe_agent' | 'help' | 'ignore'` alongside existing values. *(Req 12)*
- [ ] **AC-13**: `talkToSchema`, `observeAgentSchema`, `helpSchema`, `ignoreSchema` are exported from `packages/shared/src/schemas/llm-schemas.ts` with correct `required` fields (`talkToSchema` requires `['targetAgentId', 'message']`, the others require `['targetAgentId']`). *(Req 13)*
- [ ] **AC-14**: `talkToTool`, `observeAgentTool`, `helpTool`, `ignoreTool` are exported from `@evol-hive/shared` as `ToolDefinition` objects with correct `function.name` values. *(Req 14)*
- [ ] **AC-15**: `defaultCognitiveTools` includes entries for `talk_to`, `observe_agent`, `help`, `ignore` with `argsSchema` matching the corresponding schemas. *(Req 15)*
- [ ] **AC-16**: `MessageQueue` is implemented in `packages/engine/src/social/message-queue.ts`. `enqueue(toAgentId, message)` adds to the queue. `dequeue(agentId)` returns all messages and clears the queue. After enqueuing 2 messages and calling `dequeue`, both messages are returned and `pendingCount` is 0. *(Req 16)*
- [ ] **AC-17**: `SocialManager` is implemented in `packages/engine/src/social/social-manager.ts` and implements `SocialActionBridge`. `queueMessage(fromAgentId, toAgentId, content)` enqueues a `SocialMessage` with `fromName` looked up from the agent profile. `getAgentSummary(agentId)` returns an `AgentSummary` with `currentActivity` derived from agent state (`"thinking"` when `isThinking`, `"working on: <plan.description>"` when plan is active, `"idle"` otherwise). *(Req 17)*
- [ ] **AC-18**: `SocialManager.getAgentsInRoom(roomId, excludingAgentId)` returns `AgentSummary[]` for all agents whose `location` matches `roomId` and whose `agentId` is not `excludingAgentId`. Given 3 agents where A and B are in `"kitchen"` and C is in `"office"`, `getAgentsInRoom("kitchen", "agent-a")` returns a summary for B only. *(Req 18)*
- [ ] **AC-19**: `SocialManager.dequeueSocialMessages(agentId)` delegates to `MessageQueue.dequeue` and returns `SocialMessage[]`. After queuing a message for agent B and calling `dequeueSocialMessages("agent-b")`, the message is returned. A second call returns `[]`. *(Req 19)*
- [ ] **AC-20**: `SocialManager.getRelationships(agentId)` returns `Record<string, Relationship>` from `AgentInternalState.relationships` or `{}` when not set. *(Req 20)*
- [ ] **AC-21**: `SocialManager.updateRelationship(agentId, otherAgentId, { trust: +10 })` creates a new relationship entry (defaults: `trust: 50, familiarity: 0, lastInteraction: 0`) when none exists, merges the update (trust becomes 60), and writes it back. Calling `updateRelationship` with `{ trust: +60 }` on an existing relationship with `trust: 50` results in `trust: 100` (clamped). Calling with `{ trust: -60 }` on `trust: 50` results in `trust: 0` (clamped). *(Req 17)*
- [ ] **AC-22**: `PerceptionDataProviderImpl` implements `getAgentsInRoom`, `dequeueSocialMessages`, and `getRelationships` by delegating to `SocialManager`. When `SocialManager` is not wired, `getAgentsInRoom` returns `[]`, `dequeueSocialMessages` returns `[]`, `getRelationships` returns `{}`. *(Req 21)*
- [ ] **AC-23**: `AgentManagerImpl.spawn(profile)` with a profile having `relationships: { "agent-bob": "trusted colleague" }` creates `AgentInternalState.relationships` with `{ "agent-bob": { trust: 50, familiarity: 0, lastInteraction: 0 } }`. When `profile.relationships` is absent, `relationships` is `undefined`. *(Req 22)*
- [ ] **AC-24**: `SocialManager` and `MessageQueue` are exported from `packages/engine/src/index.ts`. *(Req 23)*
- [ ] **AC-25**: `CognitiveToolExecutorOptions` includes optional `socialBridge?: SocialActionBridge` and `currentTick?: number` fields. Existing constructors without these fields work unchanged. *(Req 24, Req 41)*
- [ ] **AC-26**: `CognitiveToolExecutorImpl.executeTalkTo` with `socialBridge` set calls `socialBridge.queueMessage`, `socialBridge.updateRelationship` (bidirectional), and `stateDataProvider.applyDriveChanges(agentId, { social: 10 })`. Returns `{ success: true, message: 'Message sent to <name>.', relationshipUpdated: true }`. *(Req 25)*
- [ ] **AC-27**: `CognitiveToolExecutorImpl.executeTalkTo` without `socialBridge` returns `{ success: false, message: 'Social actions not available.', relationshipUpdated: false }` (no error). *(Req 24, Req 25)*
- [ ] **AC-28**: `CognitiveToolExecutorImpl.executeObserveAgent` with `socialBridge` set returns `{ success: true, message: 'Observed <name>.', relationshipUpdated: true, observedAgent: { name, currentActivity, isThinking, drives } }`. When the target agent does not exist, returns `{ success: false, message: 'Agent not found.', relationshipUpdated: false }`. *(Req 26)*
- [ ] **AC-29**: `CognitiveToolExecutorImpl.executeHelp` with `socialBridge` and `stateDataProvider` set calls `updateRelationship` (bidirectional with `familiarity: +10, trust: +5`), applies `social: +15` to the helper, and applies `+10` to the target's primary drive. Returns `{ success: true, message: '...', relationshipUpdated: true }`. *(Req 27)*
- [ ] **AC-30**: `CognitiveToolExecutorImpl.executeIgnore` with `socialBridge` and `stateDataProvider` set calls `updateRelationship` with `familiarity: -2, trust: -1` and applies `social: -5` to the agent. Returns `{ success: true, message: '...', relationshipUpdated: true }`. *(Req 28)*
- [ ] **AC-31**: When any `executeSocial*` method throws internally (e.g., `socialBridge.queueMessage` throws), the error is caught and `{ success: false, message: 'Failed to ...: <error>.', relationshipUpdated: false }` is returned (no error propagated). *(Req 25–28)*
- [ ] **AC-32**: `COGNITIVE_TOOL_NAMES` in `openai-client.ts` includes `'talk_to'`, `'observe_agent'`, `'help'`, `'ignore'`. *(Req 29)*
- [ ] **AC-33**: When `cognitiveToolExecutor` is set, `agentId` is available, and the LLM calls `talk_to` with `{ targetAgentId: "agent-bob", message: "Hello!" }`, the client calls `cognitiveToolExecutor.executeTalkTo(agentId, "agent-bob", "Hello!")`, constructs a tool result message, and sends another request. A unit test with mock `fetch` verifies the second request includes the tool result message. *(Req 30)*
- [ ] **AC-34**: When the LLM calls `observe_agent` with `{ targetAgentId: "agent-bob" }`, the client calls `executeObserveAgent` and the tool result content includes the `observedAgent` JSON with the target's drives. *(Req 30, Req 31)*
- [ ] **AC-35**: When the LLM calls `help` or `ignore`, the client calls `executeHelp` or `executeIgnore` respectively, and continues the loop. *(Req 30)*
- [ ] **AC-36**: When the LLM calls a terminal tool (e.g., `choose_action`) after a social tool call, the loop terminates and the terminal tool's arguments are returned. A unit test verifies a two-turn flow: LLM calls `talk_to` → engine executes → LLM calls `choose_action` → result is the `choose_action` arguments. *(Req 30)*
- [ ] **AC-37**: When `cognitiveToolExecutor` is NOT set or `agentId` is NOT available, the client falls back to single-request behavior — no social tool execution is attempted. *(Req 30)*
- [ ] **AC-38**: `PassivePerceptionAssembler.buildPassivePerception(agentId)` calls `provider.getAgentsInRoom?.(roomId, agentId)` and includes `agentsPresent` in the `PassivePerception` when the result is non-empty. When the method is unavailable or returns `[]`, `agentsPresent` is `undefined`. *(Req 32)*
- [ ] **AC-39**: `PassivePerceptionAssembler.buildPassivePerception(agentId)` calls `provider.dequeueSocialMessages?.(agentId)` and includes `socialContext` in the `PassivePerception` when messages are pending. When no messages are pending, `socialContext` is `undefined`. *(Req 32)*
- [ ] **AC-40**: `PerceptionServiceImpl.perceive(agentId)` calls `provider.getRelationships?.(agentId)` and sets the result on `PerceptionResult.relationships`. When the method is unavailable, `relationships` is `undefined`. *(Req 37)*
- [ ] **AC-41**: `PerceptionBuilderImpl.build()` with `agentsPresent: [{ agentId: "agent-bob", name: "Bob", currentActivity: "idle", isThinking: false }]` includes `"Agents present: Bob (idle)"` in `perceptionContext` and includes `talkToTool`, `observeAgentTool`, `helpTool`, `ignoreTool` in the `tools` array. *(Req 34)*
- [ ] **AC-42**: `PerceptionBuilderImpl.build()` with `agentsPresent: []` or `undefined` does NOT include any social tools in the `tools` array (only `chooseActionTool`, `queryMemoryTool`, `updateInternalStateTool`). *(Req 34)*
- [ ] **AC-43**: `PerceptionBuilderImpl.build()` with `socialContext: [{ fromAgentId: "agent-bob", fromName: "Bob", content: "Hey Alice!", timestamp: 100 }]` includes `"Message from Bob: \"Hey Alice!\""` in `perceptionContext`. *(Req 34)*
- [ ] **AC-44**: `PerceptionBuilderImpl.build()` with `relationships: { "agent-bob": { trust: 75, familiarity: 65, lastInteraction: 100 } }` and `agentsPresent` including Bob, includes `"You trust Bob deeply"` and `"You know Bob very well"` in `perceptionContext`. *(Req 35)*
- [ ] **AC-45**: `PerceptionBuilderImpl.build()` with `relationships: { "agent-bob": { trust: 20, familiarity: 5, lastInteraction: 100 } }` and `agentsPresent` including Bob, includes `"You deeply distrust Bob"` and `"You barely know Bob"` in `perceptionContext`. *(Req 35)*
- [ ] **AC-46**: `PerceptionBuilderImpl.build()` with `primaryDriveLabel: "low social, need to restore social"` and non-empty `agentsPresent` includes `"You feel a strong need for social interaction. Consider using talk_to or help to engage with other agents in the room."` in `perceptionContext`. When the primary drive is NOT social, this hint is not included. *(Req 39)*
- [ ] **AC-47**: `PlanBuilderImpl.build()` with non-empty `agentsPresent` includes social context lines in `perceptionContext` and includes social tool definitions in the `tools` array alongside `formulatePlanTool`, `queryMemoryTool`, `updateInternalStateTool`. *(Req 38)*
- [ ] **AC-48**: `PlanBuilderImpl.build()` with `primaryDriveLabel` containing "social" and non-empty `agentsPresent` includes the social drive prompt hint. *(Req 39)*
- [ ] **AC-49**: `PerceptionResult` includes optional field `relationships?: Record<string, Relationship>`. Existing `PerceptionResult` objects without `relationships` compile without error. *(Req 36)*
- [ ] **AC-50**: An end-to-end test: Two agents (Alice, Bob) in the same room. Alice's PPER cycle produces a `PerceptionResult` with `agentsPresent` containing Bob's summary. The `PerceptionBuilderImpl` produces an `LLMContextPayload` with social context and social tools. The LLM (mock) calls `talk_to` with `{ targetAgentId: "agent-bob", message: "Hi Bob!" }`. The `CognitiveToolExecutorImpl` queues the message and updates relationships. On Bob's next Perceive tick, `PassivePerception.socialContext` contains the message from Alice. *(Req 5, Req 6, Req 25, Req 32, Req 34)*
- [ ] **AC-51**: An end-to-end test: After Alice calls `talk_to` to Bob, `AgentInternalState.relationships` for Alice includes `{ "agent-bob": { trust: 52, familiarity: 5, lastInteraction: <timestamp> } }` and for Bob includes `{ "agent-alice": { trust: 52, familiarity: 5, lastInteraction: <timestamp> } }` (bidirectional update). *(Req 25)*
- [ ] **AC-52**: An end-to-end test: Alice calls `help` on Bob. Alice's `social` drive increases by 15. Bob's primary drive (e.g., `energy` if it's lowest) increases by 10. Both agents' relationships show `familiarity: +10, trust: +5`. *(Req 27)*
- [ ] **AC-53**: An end-to-end test: Alice calls `observe_agent` on Bob. The tool result includes `observedAgent` with Bob's `name`, `currentActivity`, `isThinking`, and `drives`. Alice's relationship with Bob shows `familiarity: +1`. *(Req 26)*
- [ ] **AC-54**: `CognitiveToolExecutorImpl` imports `SocialActionBridge` from `@evol-hive/shared` (type only). It does NOT import from `@evol-hive/engine`. *(Req 42)*
- [ ] **AC-55**: `OpenAICompatibleLLMClient` imports `SocialToolResult` from `@evol-hive/shared` (type only, for JSON parsing). It does NOT import from `@evol-hive/engine`. *(Req 42)*
- [ ] **AC-56**: No files in `packages/memory/` are modified. *(Req 42)*
- [ ] **AC-57**: `docs/specs/INDEX.md` is updated with spec 018 added with status 📝 Drafted. *(Req 42)*
- [ ] **AC-58**: Existing tests that create `PassivePerception`, `PerceptionResult`, `AgentInternalState`, or `Affordance` without the new fields compile and pass without modification. *(Req 43)*
- [ ] **AC-59**: Existing mock `PerceptionDataProvider` implementations without `getAgentsInRoom`, `dequeueSocialMessages`, or `getRelationships` continue to work — `PassivePerceptionAssembler` handles missing methods gracefully (returns `undefined` for social fields). *(Req 32, Req 43)*
- [ ] **AC-60**: Existing mock `CognitiveToolExecutor` implementations without the four new social methods continue to compile (the methods are new on the interface — existing mocks that implement the interface via `implements` must add the methods, but existing mocks that use duck typing or `Partial<>` are unaffected). The LLM client handles missing methods gracefully by not executing social tools. *(Req 24, Req 30, Req 43)*

## Constraints

- **Package boundaries** (per ADR-0001): `cognition` and `engine` must not directly import from each other. `SocialActionBridge` and social types are defined in `@evol-hive/shared`. The engine implements `SocialActionBridge` (via `SocialManager`); cognition consumes it (via `CognitiveToolExecutorImpl`). The wiring happens at the application entry point. No `cognition` → `engine` or `engine` → `cognition` imports.
- **Social actions are cognitive tools, not physical affordances**: `talk_to`, `observe_agent`, `help`, and `ignore` are implemented as mid-loop cognitive tools (following spec 015's tool call loop pattern). They are NOT registered as `AffordanceHandler` entries and do NOT go through `resolveAffordance` or the `PhysicsSystem`. This avoids the mismatch between physical affordances (which target smart objects) and social actions (which target other agents). The `Affordance.targetAgentId` field is added to the type for forward compatibility but is not used by this spec.
- **Conditional tool inclusion**: Social tools are only included in the `tools` array when `PassivePerception.agentsPresent` is non-empty. This prevents the LLM from attempting social actions when no other agents are present. The existing cognitive tools (`query_memory`, `update_internal_state`) are always included regardless of social context.
- **Social tools are never masked**: Cognitive guardrails (spec 016) mask physical affordances, not cognitive tools. Social tools are cognitive tools and are therefore never masked, even when the agent has no plan. This is consistent with spec 016's principle that cognitive tools are always available.
- **Social tools in Perceive and Plan only**: Social tools are included in the `PerceptionBuilderImpl` and `PlanBuilderImpl` tool arrays. They are NOT included in the `ReflectBuilderImpl` tool array — the Reflect phase is introspective and does not perform actions.
- **Bidirectional relationship updates**: `talk_to` and `help` update relationships for both the initiator and the target (both agents' relationship maps are updated). `observe_agent` and `ignore` only update the initiator's relationship (the target is not aware of being observed or ignored, unless they have a separate mechanism to detect it).
- **Message queue is consume-on-read**: Social messages are dequeued (consumed) when the target agent's `PassivePerceptionAssembler` reads them. They appear exactly once in `socialContext`. If the agent does not perceive for multiple ticks, messages accumulate and are all delivered on the next perception tick.
- **Relationship values are clamped**: Trust and familiarity are always in the range 0–100. The `SocialManager.updateRelationship` method clamps after merging updates. Trust starts at 50 (neutral); familiarity starts at 0 (strangers).
- **Graceful degradation**: When `SocialManager` is not wired (e.g., minimal test setups without social features), all social fields are `undefined`/empty, all social tool methods return `{ success: false, ... }`, and the system behaves as before (agents are socially isolated). This is the same pattern as `MemoryInjector` (spec 014) and `CognitiveToolExecutor` (spec 015) being optional.
- **No new EngineSystem**: `SocialManager` is a passive data structure (like `SmartObjectRegistry`), not a ticked `EngineSystem`. It does not implement `update(tick)`. The message queue and relationship map are updated on-demand by social tool execution, not by the game loop.
- **What NOT to do**:
  - Do not implement social actions as physical affordances on the `AffordanceHandler` flow.
  - Do not modify the `AffordanceHandler` signature or `PhysicsSystemImpl`.
  - Do not modify the `LLMClient` interface method signatures.
  - Do not modify `packages/memory/`.
  - Do not implement streaming support.
  - Do not add new npm dependencies.
  - Do not implement relationship decay over time.
  - Do not include social tools in the Reflect phase.
  - Do not modify the `DriveDecaySystem` or `DriveSystem`.
  - Do not implement agent-to-agent physical interactions (giving items, blocking paths).
  - Do not implement a ticked `SocialSystem` — `SocialManager` is passive.
  - Do not pre-populate `Affordance.targetAgentId` — the field is for forward compatibility only.
