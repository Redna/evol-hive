# §10 — Cognitive Guardrails

## Problem

Without guardrails, LLM agents exhibit erratic "zombie" behavior — repeating failed actions, ignoring plans, or acting without thinking.

## Three Guardrail Mechanisms

### 1. Affordance Masking

If `current_plan` is empty, the engine **restricts available actions heavily** toward cognitive tools.

- Physical affordances are hidden
- Only `formulate_plan`, `query_memory`, `update_internal_state` are available
- This forces the agent to **think before acting**

### 2. Contextual Forcing

The engine injects a **strict system prompt directive** reminding the agent to use `formulate_plan`.

- Example directive: "You have no active plan. You must use formulate_plan before taking any physical action."

### 3. Plan Validation

Physical actions that **entirely deviate** from the `active_plan` are rejected.

- If the plan says "brew coffee" but the agent tries "sleep", the action is rejected
- The rejection forces a **reflection tick** — the agent must explain why it wants to deviate
- After reflection, the agent can either get back on plan or create a new one

## Configuration

| Config | Default | Description |
|--------|---------|-------------|
| `ENGINE_GUARDRAILS_ENABLED` | `true` | Master toggle |

```typescript
interface GuardrailConfig {
  affordanceMasking: boolean;   // Mask physical actions when no plan
  contextualForcing: boolean;    // Inject "use formulate_plan" directive
  planValidation: boolean;      // Reject off-plan physical actions
}
```

## Interaction with PPER Loop

```
Agent has no plan
    │
    ▼
Guardrail 1: Affordance Masking → only cognitive tools available
    │
    ▼
Guardrail 2: Contextual Forcing → "use formulate_plan" injected
    │
    ▼
LLM calls formulate_plan → plan created
    │
    ▼
Agent tries physical action off-plan
    │
    ▼
Guardrail 3: Plan Validation → rejected, reflection tick forced
    │
    ▼
Agent reflects → adjusts plan or creates new one
```

## Implementation Location

- **Type definitions**: `packages/shared/src/types/cognition.ts` (`GuardrailConfig`)
- **Guardrail engine**: `packages/cognition/src/guardrails/`