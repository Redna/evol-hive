# §8 — Cognitive Modes via Tool Calling (Internal Affordances)

## Concept

Instead of relying on rigid prompt chaining to shift the agent between modes, cognitive functions are treated as **Intrinsic Tools** (Internal Affordances).

The LLM can "call" these tools instead of performing a physical action — exactly like function/tool calling in modern LLM APIs, but the tools are cognitive operations.

## 8.1 Core Cognitive Tools

### 1. `formulate_plan`

Breaks a high-level desire into actionable steps.

```typescript
interface FormulatePlanResult {
  description: string;
  steps: { description: string; targetAffordance?: string }[];
}
```

**Example:**
- Input: Agent wants coffee (drive: energy = 15)
- Output:
  ```json
  {
    "description": "Get coffee to restore energy",
    "steps": [
      { "description": "Go to kitchen", "targetAffordance": "move_to_room" },
      { "description": "Observe the coffee machine" },
      { "description": "Brew coffee", "targetAffordance": "brew_coffee" },
      { "description": "Drink coffee", "targetAffordance": "drink_coffee" }
    ]
  }
  ```

### 2. `query_memory` (Active Recall)

Triggers a semantic search over long-term memory for specific information.

```typescript
interface QueryMemoryResult {
  memories: MemorySnippet[];
}
```

**Example:**
- Agent needs to know where coffee beans are stored
- Output: `query_memory("Where are coffee beans kept?")`
- Engine returns relevant memories via Track 2 (§11)

### 3. `update_internal_state`

Modifies the `current_goal` or `drives` based on recent observations.

```typescript
interface UpdateStateResult {
  newGoal?: string;
  driveOverrides?: Partial<Record<string, number>>;
}
```

## How It Works

1. The LLM receives the list of cognitive tools alongside pruned affordances
2. It can choose to call a cognitive tool **instead of** a physical action
3. The engine executes the tool and feeds the result back in the next tick
4. This creates a natural cognitive cycle: think → plan → recall → act

## Implementation Location

- **Tool definitions**: `packages/shared/src/types/cognition.ts`
- **Tool registry**: `packages/cognition/src/tools/`