/**
 * Spec 058 QA — INDEX status drift guard (PR #239)
 * ═══════════════════════════════════════════════════════════════════════
 * PR #239 fixed a CI-only failure: `spec-058-coverage.test.ts` pinned the
 * spec-058 INDEX row to the literal `'🔍 In Review'`, so reconciling the
 * ledger to `'✅ Done'` (PR #238) broke the `Test` job. The PR replaced the
 * pinned literal with an "is a valid status marker" regex.
 *
 * This QA guard strengthens that intent without re-pinning any mutable value:
 * the spec-058 row's status *cell* must be one of the statuses declared in the
 * INDEX `## Status Legend`. The assertion is derivable from the ledger itself,
 * so a status transition (In Review → Done) stays green while a genuinely
 * malformed / undeclared status still fails.
 *
 * Not an acceptance-criterion test — every spec-058 AC is already mapped in
 * the per-layer suites (`spec-058-coverage.test.ts` pins the routing). It is
 * a QA-added guard for the change under review.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const INDEX_PATH = join(REPO_ROOT, 'docs/specs/INDEX.md');
const SPEC_058_REF = '[058](058-eligibility-bound-plan-affordances.md)';

function readIndex(): string {
  return readFileSync(INDEX_PATH, 'utf-8');
}

/** Statuses declared in the `## Status Legend` table, e.g. `✅ Done`. */
function legendStatuses(content: string): string[] {
  const start = content.indexOf('## Status Legend');
  const end = content.indexOf('## Specs', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const section = content.slice(start, end);
  const statuses: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    const icon = cells[1] ?? '';
    const label = cells[2] ?? '';
    // Skip the header (`| Icon | Status |`) and the `| --- | --- |` separator.
    if (!icon || !label || icon === 'Icon' || /^-+$/.test(icon)) continue;
    statuses.push(`${icon} ${label}`);
  }
  return statuses;
}

function specRow(content: string): string {
  const row = content.split('\n').find((line) => line.includes(SPEC_058_REF));
  if (row === undefined) throw new Error(`INDEX row for ${SPEC_058_REF} not found`);
  return row;
}

/** The status cell of a spec table row (`| # | Feature | Arch | Status | ... |`). */
function statusCell(row: string): string {
  const cells = row.split('|').map((c) => c.trim());
  return cells[4] ?? '';
}

describe('Spec 058 — INDEX status is a legend-declared status (PR #239 guard)', () => {
  it('declares the six legend statuses', () => {
    const statuses = legendStatuses(readIndex());
    expect(statuses).toEqual(
      expect.arrayContaining([
        '📝 Drafted',
        '🔨 In Development',
        '🔍 In Review',
        '✅ Done',
        '🚫 Blocked',
        '⛔ Superseded',
      ]),
    );
  });

  it('puts a legend-declared status (and not an empty or unknown one) in the spec-058 row', () => {
    const content = readIndex();
    const status = statusCell(specRow(content));
    expect(status).not.toBe('');
    expect(legendStatuses(content)).toContain(status);
  });

  it('tolerates a status transition (the #238 In Review → Done flip) without pinning either value', () => {
    // The guard's whole point: both the pre- and post-reconciliation statuses
    // are valid, so the assertion survives a ledger update.
    const statuses = legendStatuses(readIndex());
    expect(statuses).toContain('🔍 In Review');
    expect(statuses).toContain('✅ Done');
  });
});
