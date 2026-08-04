# §6 — The PPER Loop & Environmental Awareness

## PPER Overview

The cognitive loop has four phases:

| Phase | System | Description |
|-------|--------|-------------|
| **P**erceive | System 1 (passive) | High-level awareness of surroundings |
| **P**lan | System 2 (LLM) | Break desires into actionable steps |
| **E**xecute | Engine (deterministic) | Run affordance physics |
| **R**eflect | System 2 (background) | Consolidate memories, adjust state |

## 6.1 Perceive (Passive — System 1) & Spatial Debouncing

### Mechanism

As the agent moves, the engine logs the **high-level presence** of nearby objects.

### Spatial Debouncing

To prevent the engine from spamming the LLM with perception data every frame (60 FPS), perception is **debounced**:

- A new perception tick is triggered **only if**:
  - The agent crosses a **room threshold**, OR
  - The agent has been **idle in a space** for more than X seconds

### Output

The LLM knows a `CoffeeMachine` is in the room, but does **not** know its current state (e.g., water level). That requires explicit `observe`.

## 6.2 Observe (Active — System 2)

### Mechanism

`observe(target)` is provided as a **universal, intrinsic action**.

### Usage

If the agent decides it needs to interact with an object, it outputs the `observe` action.

### Result

The engine responds in the next tick with the object's **deep JSON state** (e.g., `water_level: low`, `bean_count: 12`).

## Context Window Optimization

| What | When | Tokens |
|------|------|--------|
| Object names (passive) | On perception tick (debounced) | Low |
| Object deep state (active) | Only when agent calls `observe` | Medium |
| Affordance list (pruned) | Only top-K from System 0 | Low |

This split prevents token bloat from dumping all object states every tick.

## Implementation Location

- **PPER orchestration**: `packages/cognition/src/pper/`
- **Spatial debouncing**: `packages/engine/src/spatial/`
- **Perception builder**: `packages/cognition/src/index.ts` (`PerceptionBuilder`)