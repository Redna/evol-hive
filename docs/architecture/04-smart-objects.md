# §4 — Smart Objects & Affordances

## Concept

To prevent the LLM from hallucinating interactions or requiring complex string parsing, the environment is built using **Smart Objects**.

## Definition

Every interactable entity in the game world exposes a discrete list of **Affordances** — actions it supports.

## Decoupling

The LLM does **not** know the underlying code. It only receives the semantic representation of an affordance (e.g., `brew_coffee`).

## Engine Effect

When the LLM selects an affordance, the TypeScript engine cross-references it with the object's `engineEffect` and executes the deterministic physics code.

## Schema

```typescript
interface SmartObject {
  id: string;
  name: string;              // Display name (e.g., "Coffee Machine")
  type: string;               // Object type for affordance grouping
  state: Record<string, unknown>;  // Deep state (e.g., { water_level, bean_count })
  affordances: Affordance[];
  roomId: string;
}

interface Affordance {
  id: string;                 // Semantic name for LLM (e.g., "brew_coffee")
  label: string;              // Human/LLM-readable description
  engineEffect: string;       // Deterministic function to invoke
  preconditions: string[];    // Checks before execution (e.g., "has_water")
  effects: Record<string, number>;  // Drive impacts on success
}
```

## Execution Flow

```
LLM selects affordance "brew_coffee"
        │
        ▼
Engine looks up SmartObject → Affordance
        │
        ▼
Check preconditions (e.g., water_level > 0?)
        │
    ┌───┴───┐
    │       │
  Pass    Fail
    │       │
    ▼       ▼
Execute  Return AffordanceResult
physics  { success: false,
code     failureReason: "No water in machine" }
    │            │
    ▼            ▼
Apply     Inject system feedback
drive     into next perception tick
effects   (prevents infinite loop)
```

## Implementation Location

- **Type definitions**: `packages/shared/src/types/affordance.ts`
- **Object registry**: `packages/engine/src/world/objects/`
- **Affordance registry**: `packages/engine/src/world/affordances/`