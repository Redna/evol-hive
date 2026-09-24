/**
 * QA companion to `spec-index-integrity.test.ts` (PR #255).
 * =========================================================
 * The developer's guard proves the INDEX ↔ files bijection. Two things it does
 * NOT assert are checked here, because they are the substantive *fixes* this PR
 * claims and the guard only checks cardinality, not content:
 *
 *   1. **Provenance.** The duplicate `019-affordance-as-tools.md` row was
 *      removed and its PR link (`#80`) carried into the surviving row, which
 *      had an em-dash where the PR belonged. A bijection guard cannot see a
 *      missing link; a row with `—` still resolves to a real file.
 *   2. **The repaired row for the previously-missing file.** `022-performance-tuning.md`
 *      had no row at all; the new row must carry the right issue (#91) and PR (#97),
 *      not merely exist.
 *
 * It also adds two independent cross-checks, deliberately computed with a
 * different algorithm than the developer guard so a shared bug cannot hide:
 *
 *   3. A Set-based symmetric-difference on files ↔ rows (the guard compares
 *      with `.some`/`.filter`; this compares sorted unique arrays).
 *   4. A status-vocabulary check: every row's status must be one of the six
 *      legend values. The developer guard only compares declared labels to the
 *      rows, so a mis-typed status can in principle be masked by adjusting the
 *      summary. This pins the vocabulary.
 *
 * Policy test in the CLI test dir — same precedent as
 * `spec-217-docs-only-qa-gate.test.ts`; there is no runtime surface to exercise.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SPECS_DIR = join(REPO_ROOT, 'docs/specs');
const INDEX = readFileSync(join(SPECS_DIR, 'INDEX.md'), 'utf8');

const specFiles = readdirSync(SPECS_DIR)
  .filter((f) => /^\d{3}-[a-z0-9-]+\.md$/.test(f))
  .sort();

type Row = { number: string; file: string; status: string; issue: string; pr: string };

/** Full row parser: keeps issue/PR columns, which the developer guard discards. */
const rows: Row[] = INDEX.split('\n')
  .map((line) => /^\|\s*\[(\d{3})\]\((\d{3}-[a-z0-9-]+\.md)\)\s*\|(.*)$/.exec(line))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => {
    // m[3] = "title | sections | status | issue | pr | packages "
    const cells = m[3]!.split('|').map((c) => c.trim());
    const linkNumber = (cell: string | undefined): string => {
      const found = cell?.match(/#(\d+)/);
      return found ? `#${found[1]}` : '—';
    };
    return {
      number: m[1]!,
      file: m[2]!,
      // cells[0] title, [1] sections, [2] status, [3] issue, [4] PR
      status: cells[2] ?? '',
      issue: linkNumber(cells[3]),
      pr: linkNumber(cells[4]),
    };
  });

const rowsFor = (file: string): Row[] => rows.filter((r) => r.file === file);

/** Legend vocabulary, normalising `⛔ Superseded by NNN` to the bare label. */
const KNOWN_STATUSES = [
  '✅ Done',
  '🔨 In Development',
  '🔍 In Review',
  '📝 Drafted',
  '🚫 Blocked',
  '⛔ Superseded',
];
const normalizeStatus = (status: string): string =>
  status.replace(/^⛔ Superseded\b.*$/, '⛔ Superseded');

describe('spec index integrity (QA): provenance of the #255 fixes', () => {
  it('019-affordance-as-tools.md has exactly one row, carrying PR #80', () => {
    const matching = rowsFor('019-affordance-as-tools.md');
    expect(matching, 'the duplicate 019-affordance-as-tools.md row must be gone').toHaveLength(1);
    const [row] = matching;
    expect(row!.number).toBe('019');
    expect(row!.issue).toBe('#71');
    // The provenance the duplicate was hiding: the surviving row had an em-dash.
    expect(row!.pr, "the surviving 019 row must carry the duplicate's PR link #80").toContain(
      '#80',
    );
  });

  it('022-performance-tuning.md has exactly one row with issue #91 / PR #97', () => {
    const matching = rowsFor('022-performance-tuning.md');
    expect(matching, 'the previously-missing 022 row must be present exactly once').toHaveLength(1);
    const [row] = matching;
    expect(row!.number).toBe('022');
    expect(row!.issue).toBe('#91');
    expect(row!.pr).toBe('#97');
  });

  it('files and rows are set-equal (independent symmetric-difference check)', () => {
    const fileSet = [...new Set(specFiles)].sort();
    const rowFileSet = [...new Set(rows.map((r) => r.file))].sort();
    const onlyOnDisk = fileSet.filter((f) => !rowFileSet.includes(f));
    const onlyInIndex = rowFileSet.filter((f) => !fileSet.includes(f));
    expect(onlyOnDisk, `spec file(s) with no row: ${onlyOnDisk.join(', ')}`).toEqual([]);
    expect(onlyInIndex, `row(s) with no file: ${onlyInIndex.join(', ')}`).toEqual([]);
    // No duplicate rows, expressed as a set-size equality.
    expect(rowFileSet.length).toBe(rows.length);
  });

  it('every row status is one of the six legend values', () => {
    const unknown = rows
      .map((r) => r.status)
      .filter((s) => !KNOWN_STATUSES.includes(normalizeStatus(s)));
    expect(unknown, `row status outside the legend: ${unknown.join(', ')}`).toEqual([]);
  });
});
