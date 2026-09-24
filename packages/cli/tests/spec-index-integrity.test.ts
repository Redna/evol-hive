/**
 * Spec ledger integrity guard — docs/specs/INDEX.md ↔ docs/specs/*.md
 * ==================================================================
 * `docs/specs/` is the product ledger (DELIVERY_PROCEDURE.md): the INDEX is the
 * authoritative record of what has been specified, built and superseded.
 *
 * It drifted twice, and both times the drift was invisible to a count check:
 *
 *   1. `019-affordance-as-tools.md` had TWO rows while `022-performance-tuning.md`
 *      had NONE. The duplicate inflated `✅ Done` by one and the missing file
 *      deflated it by one, so the summary still read the "correct" 68. A check
 *      that compared totals (71 rows vs 71 files) passed while the ledger was
 *      wrong. That is the whole reason this guard compares SETS, not counts.
 *   2. `023-visual-output-canvas-renderer.md` had a file and no row at all
 *      (issue #89, PR #95, added in #250).
 *
 * So this asserts a bijection, which a count can never prove: every spec file
 * has exactly one row, every row resolves to a real file, a row's link number
 * matches the file it names, and the summary tally equals the rows.
 *
 * Deliberately NOT asserted: that spec NUMBERS are unique. Four of them are
 * shared in the historical ledger (008, 018, 019, 022) — that is real history,
 * not drift, and a guard that demanded unique numbers would fail on valid data.
 *
 * This is a policy test, not a spec test — same precedent as
 * `spec-217-docs-only-qa-gate.test.ts` and `adr-003-ci-memory-scope.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SPECS_DIR = join(REPO_ROOT, 'docs/specs');
const INDEX_PATH = join(SPECS_DIR, 'INDEX.md');

const INDEX = readFileSync(INDEX_PATH, 'utf8');

/** Spec files on disk. INDEX.md and TEMPLATE.md are not specs. */
const specFiles = readdirSync(SPECS_DIR)
  .filter((f) => /^\d{3}-[a-z0-9-]+\.md$/.test(f))
  .sort();

type Row = { number: string; file: string; status: string };

/**
 * Rows look like:
 *   | [019](019-affordance-as-tools.md) | Title | §4, §6 | ✅ Done | [#71](…) | [#80](…) | pkg |
 * Fields between the pipes are: '', link, title, sections, status, issue, pr, packages, ''.
 */
const rows: Row[] = INDEX.split('\n')
  .map((line) => /^\|\s*\[(\d{3})\]\((\d{3}-[a-z0-9-]+\.md)\)\s*\|(.*)$/.exec(line))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => {
    const cells = m[3]!.split('|');
    // cells[0] = title, [1] = sections, [2] = status
    return { number: m[1]!, file: m[2]!, status: (cells[2] ?? '').trim() };
  });

/** `⛔ Superseded by 011` tallies under the summary's `⛔ Superseded` label. */
const normalizeStatus = (status: string): string =>
  status.replace(/^⛔ Superseded\b.*$/, '⛔ Superseded');

describe('spec ledger: INDEX ↔ files bijection', () => {
  it('found the ledger it expects to guard', () => {
    expect(specFiles.length).toBeGreaterThan(60);
    expect(rows.length).toBeGreaterThan(60);
  });

  it('every spec file has exactly one INDEX row', () => {
    const missing = specFiles.filter((f) => !rows.some((r) => r.file === f));
    expect(missing, `spec file(s) with no INDEX row: ${missing.join(', ')}`).toEqual([]);
  });

  it('every INDEX row resolves to a real spec file', () => {
    const dangling = rows.filter((r) => !specFiles.includes(r.file)).map((r) => r.file);
    expect(dangling, `INDEX row(s) pointing at no file: ${dangling.join(', ')}`).toEqual([]);
  });

  it('no spec file is listed twice', () => {
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.file, (seen.get(r.file) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([f, n]) => `${f} ×${n}`);
    expect(dupes, `duplicate INDEX row(s): ${dupes.join(', ')}`).toEqual([]);
  });

  it("a row's link number matches the file it names", () => {
    const mismatched = rows
      .filter((r) => !r.file.startsWith(`${r.number}-`))
      .map((r) => `[${r.number}] -> ${r.file}`);
    expect(mismatched).toEqual([]);
  });

  it('the summary tally equals the rows, and Total equals the file count', () => {
    const actual = new Map<string, number>();
    for (const r of rows) {
      const key = normalizeStatus(r.status);
      actual.set(key, (actual.get(key) ?? 0) + 1);
    }

    const declared = new Map<string, number>();
    for (const m of INDEX.matchAll(
      /^(Total specs|✅ Done|🔨 In Development|🔍 In Review|📝 Drafted|🚫 Blocked|⛔ Superseded):\s+(\d+)$/gm,
    )) {
      declared.set(m[1]!, Number(m[2]));
    }

    // Every declared status line must match the rows it summarises.
    for (const [label, count] of declared) {
      if (label === 'Total specs') continue;
      expect(actual.get(label) ?? 0, `summary says ${label} = ${count}`).toBe(count);
    }

    // Total is the ledger's size, and the ledger is the set of files.
    expect(declared.get('Total specs')).toBe(specFiles.length);
    expect(rows.length).toBe(specFiles.length);
  });
});
