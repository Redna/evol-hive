# §7 — Strict JSON Schema (Structured Outputs)

## Principle

The engine strictly relies on **Structured Outputs** to parse LLM intentions.

- **No regex**
- **No string matching**
- **No fragile parsing**

## Tool Calling (spec 011)

Structured outputs are achieved via **tool calling** — the OpenAI-compatible
`tools` parameter. Tool definitions (one per PPER phase) are sent with each
request, and the LLM returns `tool_calls[0].function.arguments` — always valid
JSON with exact field names from the tool's parameter schema.

This is an even stronger guarantee than `response_format` because the LLM
provider validates the tool arguments against the schema before returning them.

### Tool Definitions

| Phase | Tool | Parameters Schema |
|-------|------|-------------------|
| Plan | `formulate_plan` | `formulatePlanSchema` |
| Execute | `choose_action` | `llmActionResponseSchema` |
| Reflect | `reflect` | `reflectSchema` |
| Memory Consolidation | `consolidate_memories` | `memoryConsolidationSchema` |

### Required LLM Output Schema

```typescript
interface LLMActionResponse {
  reasoning: string;       // Internal monologue (not shown to player)
  action: string;          // Affordance ID or cognitive tool name
  actionArgs?: Record<string, unknown>;
  observeTarget?: string;  // Object ID to observe before acting
  updatedGoal?: string;    // Updated goal if changed
}
```

## Why This Matters

Without structured outputs, the LLM might return:
- Prose that requires complex parsing
- Hallucinated action names that don't exist
- Malformed JSON that crashes the engine

With tool calling, the LLM output is **guaranteed** to conform to the schema,
making the engine-to-LLM bridge deterministic and reliable.

## Schema Definitions

Full schemas are defined in:
- `packages/shared/src/schemas/llm-schemas.ts`

## Implementation Location

- **Schema definitions**: `packages/shared/src/schemas/llm-schemas.ts`
- **Tool definitions**: `packages/shared/src/schemas/llm-schemas.ts`
- **LLM client (tool calling)**: `packages/cognition/src/llm/openai-client.ts` (`OpenAICompatibleLLMClient`)