# §3 — Agent Internal State Schema

## Purpose

To anchor the agent's behavior and avoid prompt-drifting, each agent maintains a strict internal state object in the TypeScript engine. This state dictates their immediate needs and informs the System 0 Classifier.

## Schema

```typescript
interface AgentInternalState {
  agentId: string;
  drives: AgentDrives;          // Primary motivational state (0-100 each)
  currentGoal: string;            // Current high-level goal
  currentPlan: AgentPlan | null;  // Active plan from formulate_plan
  isThinking: boolean;            // Awaiting LLM response (async)
  location: string;               // Room/scene ID
  lastPerceptionTick: number;     // For spatial debouncing
}

interface AgentDrives {
  energy: number;    // 0-100
  hunger: number;    // 0-100
  social: number;    // 0-100
  comfort: number;   // 0-100
  curiosity: number; // 0-100
}
```

## Drives

Drives are the agent's motivational state. They:
- **Decay over time** (simulated biological needs)
- **Are modified by affordance effects** (e.g., `brew_coffee` → `energy: +20`)
- **Determine the primary drive** — the highest-urgency drive that feeds into the System 0 Classifier

## Plan

The `currentPlan` is set by the `formulate_plan` cognitive tool. It contains:
- A description of the high-level desire
- A sequence of actionable steps
- The current step index (progression tracking)

When `currentPlan` is `null`, Cognitive Guardrails (§10) restrict available actions toward cognitive tools.

## Implementation Location

- **Type definitions**: `packages/shared/src/types/agent.ts`
- **State management**: `packages/agents/src/state/`
- **Drive system**: `packages/agents/src/drives/`
- **Plan management**: `packages/agents/src/plans/`