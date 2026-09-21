/**
 * renderer/format.ts — DOM-free text helpers (issue #105, spec 062 R5).
 * Kept separate from the skin so both the renderer and the client bundle can
 * import them without a cycle.
 */

/**
 * Format an object state key/value line for the object chip (issue #105).
 * Numeric values are rounded to 1 decimal (state rules decay by fractions,
 * which used to render as "95.666666674"). The VALUE stays visible — the KEY
 * is truncated first, then the line is clamped to the chip width.
 */
export function formatStateLine(key: string, val: unknown, maxWidthPx = 56): string {
  let valueText: string;
  if (typeof val === 'number') {
    valueText = String(Math.round(val * 10) / 10);
  } else if (typeof val === 'string' || typeof val === 'boolean') {
    valueText = String(val);
  } else {
    valueText = JSON.stringify(val);
  }
  // Approximate rendered width (10px sans-serif ≈ 5.5px/char). Approximating
  // keeps this DOM-free and usable in Node tests.
  const approxWidth = (s: string): number => s.length * 5.5;
  const maxKeyChars = 10;
  let shortKey = key.length > maxKeyChars ? key.slice(0, maxKeyChars) : key;
  let line = `${shortKey}: ${valueText}`;
  while (approxWidth(line) > maxWidthPx && shortKey.length > 1) {
    shortKey = shortKey.slice(0, -1);
    line = `${shortKey}: ${valueText}`;
  }
  return line;
}

/** Extract up to two initials from a name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0];
  if (first === undefined || first === '') return '?';
  const second = parts[1];
  if (second === undefined || second === '') return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ''}${second[0] ?? ''}`.toUpperCase();
}

/** Truncate text to `maxChars` with an ellipsis (approximate, DOM-free). */
export function truncate(text: string, maxChars: number): string {
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars));
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
