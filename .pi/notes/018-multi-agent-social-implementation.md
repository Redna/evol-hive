# Implementation Note — feature/062-multi-agent-social

**Spec:** [018-multi-agent-social.md](../../docs/specs/018-multi-agent-social.md)
**Issue:** [#62](https://github.com/Redna/evol-hive/issues/62)
**Branch:** `feature/062-multi-agent-social`
**Date:** 2025-01-24

## What was built

Multi-Agent Social system — four capabilities that build on the existing PPER loop and cognitive tool infrastructure:

1. **Agent-to-agent perception** — `AgentSummary` objects in `PassivePerception.agentsPresent` (other agents in the same room)
2. **Social cognitive tools** — `talk_to`, `observe_agent`, `help`, `ignore` as mid-loop cognitive tools (executed and fed back to the LLM)
3. **Inter-agent communication** — `talk_to` queues `SocialMessage` for the target agent; messages appear in `PassivePerception.socialContext` on the target's next Perceive tick
4. **Structured relationship tracking** — `AgentInternalState.relationships` as `Record<string, Relationship>` with trust (0–100) and familiarity (0–100); updated by social interactions; converted to natural-language context in builders

### Changes by package

**Shared (`@evol-hive/shared`):**
- New types in `types/cognition.ts`: `AgentSummary`, `SocialMessage`, `SocialToolResult`, `SocialActionBridge`
- `PassivePerception` extended with `agentsPresent?` and `socialContext?`
- `PerceptionResult` extended with `relationships?`
- `PerceptionDataProvider` extended with `getAgentsInRoom?`, `dequeueSocialMessages?`, `getRelationships?`
- `CognitiveToolExecutor` extended with `executeTalkTo`, `executeObserveAgent`, `executeHelp`, `executeIgnore`
- `CognitiveToolName` extended with `'talk_to' | 'observe_agent' | 'help' | 'ignore'`
- New type `Relationship` in `types/agent.ts`
- `AgentInternalState` extended with `relationships?`
- `Affordance` extended with `targetAgentId?`
- New schemas in `schemas/llm-schemas.ts`: `talkToSchema`, `observeAgentSchema`, `helpSchema`, `ignoreSchema`
- New tool constants: `talkToTool`, `observeAgentTool`, `helpTool`, `ignoreTool`

**Engine (`@evol-hive/engine`):**
- New `social/message-queue.ts` — `MessageQueue` class (in-memory per-agent queues)
- New `social/social-manager.ts` — `SocialManager` class implementing `SocialActionBridge`
- `PerceptionDataProviderImpl` extended with `setSocialManager`, `getAgentsInRoom`, `dequeueSocialMessages`, `getRelationships`
- `AgentManagerImpl.spawn` seeds `relationships` from `AgentProfile.relationships`
- Exports added for `SocialManager` and `MessageQueue`

**Cognition (`@evol-hive/cognition`):**
- `CognitiveToolExecutorImpl` extended with `socialBridge` and `currentTick` options; four social methods implemented
- `defaultCognitiveTools` extended with 4 social tool entries
- `COGNITIVE_TOOL_NAMES` updated to include social tools
- Tool call loop in `openai-client.ts` handles `talk_to`, `observe_agent`, `help`, `ignore`
- `PassivePerceptionAssembler` populates `agentsPresent` and `socialContext`
- `PerceptionServiceImpl` populates `relationships` on `PerceptionResult`
- `PerceptionBuilderImpl` adds social context lines, social tools, relationship context, social drive hint
- `PlanBuilderImpl` adds social context lines, social tools, relationship context, social drive hint

## Test files

- `packages/shared/tests/spec-018-social-types.test.ts` — 29 tests (AC-1 through AC-15, AC-49, AC-58)
- `packages/engine/tests/spec-018-social.test.ts` — 23 tests (AC-16 through AC-24)
- `packages/cognition/tests/spec-018-social.test.ts` — 42 tests (AC-25 through AC-48, AC-54, AC-55, AC-59)

## Test results

- `pnpm test` — ✅ All pass
- `pnpm typecheck` — ✅ Clean
- `pnpm lint` — ✅ Clean
- `pnpm format:check` — ✅ Clean
- `pnpm build` — ✅ Success