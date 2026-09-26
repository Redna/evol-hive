/**
 * Spec 066 AC-12 — the ledger deliverables (QA companion).
 *
 * AC-12 is a documentation criterion with no runtime surface: specs 062/063
 * must carry an in-place amendment note pointing at 066, and `docs/specs/INDEX.md`
 * must reflect 066's status. This is a policy guard, the same precedent as
 * `spec-index-integrity-qa.test.ts`; it asserts the *existence and linkage* of
 * the amendment notes rather than their prose, so wording changes do not rot it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SPECS_DIR = resolve(__dirname, '../../../docs/specs');
const read = (file: string): string => readFileSync(join(SPECS_DIR, file), 'utf8');
const INDEX = read('INDEX.md');

/** Parse an INDEX row for a given spec file, returning its status cell. */
function indexStatusFor(file: string): string | undefined {
  for (const line of INDEX.split('\n')) {
    const m = /^\|\s*\[(\d{3})\]\((\d{3}-[a-z0-9-]+\.md)\)\s*\|(.*)$/.exec(line);
    if (m === null || m[2] !== file) continue;
    const cells = m[3]!.split('|').map((c) => c.trim());
    return cells[2]; // title | sections | status | issue | PR | packages
  }
  return undefined;
}

describe('spec 066 AC-12 — amendments and INDEX status', () => {
  it('spec 062 carries an in-place amendment note linking to 066', () => {
    const spec = read('062-visualizer-world-view.md');
    expect(spec).toContain('Amended by [066](066-visualizer-live-observation-defects.md)');
  });

  it('spec 063 carries an in-place amendment note linking to 066', () => {
    const spec = read('063-visualizer-mobile-shell.md');
    expect(spec).toContain('Amended by [066](066-visualizer-live-observation-defects.md)');
  });

  it('INDEX.md lists 066 as Done, matching the spec header', () => {
    expect(indexStatusFor('066-visualizer-live-observation-defects.md')).toBe('✅ Done');
    const spec = read('066-visualizer-live-observation-defects.md');
    expect(spec).toContain('- Status: ✅ Done');
  });

  it('spec 066 has no unticked acceptance criteria (no Done spec with open boxes)', () => {
    const spec = read('066-visualizer-live-observation-defects.md');
    expect(spec.match(/^- \[ \] \*\*AC-/gm) ?? []).toEqual([]);
    expect((spec.match(/^- \[x\] \*\*AC-/gm) ?? []).length).toBe(12);
  });
});
