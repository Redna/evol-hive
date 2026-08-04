# §7 — Strict JSON Schema (Structured Outputs)

## Principle

The engine strictly relies on **Structured Outputs** (Grammar Constraints) to parse LLM intentions.

- **No regex**
- **No string matching**
- **No fragile parsing**

## Required LLM Output Schema

```typescript
interface LLMActionResponse {
  reasoning: string;       // Internal monologue (not shown to player)
  action: string;          // Affordance ID or cognitive tool name
  actionArgs?: Record<string, unknown>;
  observeTarget?: string;  // Object ID to observe before acting
  updatedGoal?: string;    // Updated goal if changed
}
```

## Grammar Constraints

The schema is passed to the LLM backend as a grammar constraint / `response_format`:

- **Ollama**: `format` parameter with JSON schema
- **vLLM**: `guided_json` / `guided_grammar` parameter
- **llama.cpp**: `grammar` parameter with GBNF rules

## Why This Matters

Without structured outputs, the LLM might return:
- Prose that requires complex parsing
- Hallucinated action names that don't exist
- Malformed JSON that crashes the engine

With grammar constraints, the LLM output is **guaranteed** to conform to the schema, making the engine-to-LLM bridge deterministic and reliable.

## Schema Definitions

Full schemas are defined in:
- `packages/shared/src/schemas/llm-schemas.ts`

## Implementation Location

- **Schema definitions**: `packages/shared/src/schemas/llm-schemas.ts`
- **LLM client (structured output)**: `packages/cognition/src/index.ts` (`LLMClient`)