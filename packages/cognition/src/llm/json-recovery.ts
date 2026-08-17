/**
 * llm/json-recovery — JSON extraction utility (spec 009, Req 19)
 * ────────────────────────────────────────────────────────────────────────────
 * Simple substring-based JSON extraction. When `JSON.parse(content)` fails,
 * `requestChat()` uses this to attempt to salvage a JSON object or array from
 * raw LLM text that may be wrapped in prose or XML-like tags.
 *
 * Intentionally simple — uses `String.indexOf`/`lastIndexOf` and `JSON.parse()`
 * only. No regex library, no JSON repair library (ADR-0001 lean monorepo).
 */

/**
 * Attempt to extract a JSON object or array from a raw text string.
 *
 * Strategy (spec 009, Req 1):
 *   1. Search for the first `{` and the last `}` — try `JSON.parse()` on the
 *      substring. If it succeeds, return the parsed value.
 *   2. If that fails, search for the first `[` and the last `]` (array case)
 *      and try `JSON.parse()`. If it succeeds, return the parsed value.
 *   3. If both fail, return `null`.
 *
 * When both object braces and array brackets are present, the object is tried
 * first (step 1). This handles the common case of `<tag>{...}</tag>` while
 * still falling back to arrays when the object braces don't form valid JSON.
 *
 * @returns `{ json }` on success, or `null` when no valid JSON is found.
 */
export function extractJsonFromText(
  content: string,
): { json: Record<string, unknown> | unknown[] } | null {
  if (typeof content !== 'string' || content.length === 0) {
    return null;
  }

  // Step 1: object extraction ({ ... }).
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = content.slice(firstBrace, lastBrace + 1);
    try {
      const json = JSON.parse(candidate) as Record<string, unknown> | unknown[];
      // Only accept objects or arrays (not primitives).
      if (typeof json === 'object' && json !== null) {
        return { json };
      }
    } catch {
      // Fall through to array extraction.
    }
  }

  // Step 2: array extraction ([ ... ]).
  const firstBracket = content.indexOf('[');
  const lastBracket = content.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const candidate = content.slice(firstBracket, lastBracket + 1);
    try {
      const json = JSON.parse(candidate) as unknown[];
      if (Array.isArray(json)) {
        return { json };
      }
    } catch {
      // Fall through — no valid JSON found.
    }
  }

  return null;
}
