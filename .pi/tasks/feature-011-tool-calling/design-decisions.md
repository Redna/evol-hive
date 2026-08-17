# Design Decisions — Feature 011: Tool Calling

## Decision 1: Tool calling replaces response_format entirely
**Why**: Ollama's native tool calling is a core feature that guarantees valid JSON with correct field names. This eliminates the entire recovery stack (spec 009: JSON extraction, re-prompt, provider-aware format selection) and the schema-in-prompt workaround (spec 010: schema hints, field aliasing). The complexity reduction is ~500 lines of code across 3 specs → 1 tool definition per phase.

**Alternative considered**: Keep response_format as a fallback when tool calling is not supported. Rejected — tool calling is listed as supported in Ollama's OpenAI compatibility docs and is a core feature. Adding a fallback would re-introduce the exact complexity we're removing.

## Decision 2: LLMContextPayload.tools replaces responseSchema + schemaHint
**Why**: The `tools` field carries the tool definitions that the LLM calls. This is a cleaner abstraction than `responseSchema` (which needed `response_format` wrapping) + `schemaHint` (which was a text workaround for providers that ignored `response_format`). The tool definitions carry both the schema AND the semantic name/description.

**Impact**: Breaking change for code that constructs `LLMContextPayload`, but all such code is in the cognition package (builders) and is updated in this spec. The `LLMClient` interface method signatures are unchanged.

## Decision 3: One primary tool per PPER phase + cognitive tools for Execute phase
**Why**: Each PPER phase has a specific purpose (plan, choose action, reflect). Sending one primary tool per phase keeps the LLM focused. For the Execute/Perceive phase, cognitive tools (query_memory, update_internal_state) are also sent as tool definitions so the LLM can call them naturally instead of inventing a tool name string.

**Alternative considered**: Send all cognitive tools in all phases. Rejected — the Plan phase should only call `formulate_plan`, and the Reflect phase should only call `reflect`. Sending extra tools would confuse the LLM.

## Decision 4: No tool call loop (single request → single tool call)
**Why**: The PPER loop already handles multi-step cognition across ticks. A tool call loop (where the engine sends tool results back to the LLM for multi-turn use) would add complexity without clear benefit at this stage. The LLM "calling" a tool is just a structured output mechanism — the engine interprets the arguments, it doesn't execute the tool.

**Future**: A tool call loop could be added later if the LLM needs to, e.g., call `query_memory` and then `choose_action` in the same tick. This is explicitly out of scope.

## Decision 5: reasoning_effort config option
**Why**: The issue mentions ~11s response times without reasoning control vs ~2-3s with `reasoning_effort: "low"`. This is a simple config field that maps to the OpenAI/Ollama `reasoning_effort` parameter. It's optional with no default (provider default applies).

## Decision 6: Specs 009 and 010 superseded, not deleted
**Why**: The spec files remain in docs/specs/ for historical reference. Their code is deleted, but the design rationale documented in those specs is valuable context for understanding why tool calling is the better approach. INDEX.md status updated to ⛔ Superseded by 011.

## Decision 7: Existing JSON schemas reused as tool parameters
**Why**: The schemas (`formulatePlanSchema`, `llmActionResponseSchema`, `reflectSchema`, `memoryConsolidationSchema`) already define the correct field names and types. They work as-is as tool `parameters` — no modification needed. The tool definition is just a thin wrapper: `{ type: 'function', function: { name, description, parameters: <existing schema> } }`.

## Decision 8: cognitiveToolsToToolDefinitions helper
**Why**: Cognitive tools are currently defined as `CognitiveTool[]` with `argsSchema`. Converting them to `ToolDefinition[]` requires mapping `argsSchema` → `parameters`. A helper function keeps this conversion in one place and is reusable.
