# §9 — TypeScript Engine Routing & Asynchronous Execution

## The Latency Problem

The deterministic physics engine runs at 60 FPS. LLM generation takes 100ms–5s. If the game loop waited for the LLM, the simulation would freeze.

## 9.1 Asynchronous State Management

When an agent is queried for an action, its physics state is set to `is_thinking: true`.

- The **game loop continues** to run for other agents and physics objects
- The **LLM call happens asynchronously** in the background
- Once the LLM returns the payload, the engine routes it

### Flow

```
Game Tick N
│
├─ Agent A: isThinking = true → skip physics update
├─ Agent B: active → update physics
├─ Agent C: active → update physics
│
└─ LLM Response arrives for Agent A
    │
    ├─ Parse structured output
    ├─ Route action:
    │   ├─ Physical affordance → execute physics
    │   ├─ Cognitive tool → execute tool
    │   └─ observe(target) → queue observation for next tick
    │
    └─ Set isThinking = false
```

## 9.2 Action Feedback Loop

If an agent tries `brew_coffee` but the physics engine knows there is no water:

1. The engine intercepts the failure
2. Automatically injects a **System Feedback** note into the agent's next Perceive step
3. The feedback message informs the agent why the action failed
4. This prevents the agent from **infinitely looping** a broken action

### Example

```
Tick N: Agent → brew_coffee
Tick N+1: Engine → AffordanceResult { success: false, failureReason: "No water" }
Tick N+2: Perception includes systemFeedback: "You tried to brew coffee but the machine has no water."
         Agent adjusts plan → formulate_plan or observe(coffee_machine)
```

## Concurrency Control

The engine limits concurrent LLM calls via `LLMConcurrencyManager`:

| Config | Default | Description |
|--------|---------|-------------|
| `ENGINE_MAX_CONCURRENT_LLM` | 8 | Max simultaneous LLM calls |

## Implementation Location

- **Game loop**: `packages/engine/src/loop/`
- **Action routing**: `packages/engine/src/routing/`
- **Concurrency manager**: `packages/engine/src/routing/`