/**
 * PR #249 QA coverage — origin/memory is deleted, and every live doc says so
 * ============================================================================
 * This PR is the second follow-up to #247. ADR-003 originally decided the
 * `origin/memory` branch would be **frozen, not deleted**; an operator then
 * deleted it. The reference contract is the ADR
 * (`docs/adr/0003-memory-is-local-ci-runs-none.md`) plus the PR body's claims;
 * there is no feature spec (harness/docs change — the same precedent as
 * #247/#248, recorded in the two `adr-003-*` QA notes files).
 *
 * The developer updated the #247 guard in `adr-003-ci-memory-scope-qa.test.ts`
 * to assert the ADR now says **deleted** and records a tip SHA, and left the
 * "no automation deletes or force-pushes memory" guard untouched. That guard
 * only looks at the ADR decision text; the PR body's remaining claims — the
 * *Given up* paragraph and the corrections in `AGENT_TEAM_SETUP.md` and
 * `MEMORY_PIPELINE.md` — were unguarded. QA locks them here:
 *
 *   AC-1  the ADR records the deletion, the exact recoverable tip SHA
 *         (`3c20d804`), and the out-of-repo archive
 *   AC-2  the ADR *Given up* paragraph no longer offers a frozen in-repo
 *         archive / "read-only historical artifact" — recovery is out-of-repo
 *   AC-3  `AGENT_TEAM_SETUP.md`'s memory table row, file-tree line and
 *         decision-log row all mark the git `memory` branch deleted/retired
 *   AC-4  `MEMORY_PIPELINE.md`'s superseded banner records the branch deletion
 *         and points at the ADR for the tip
 *   AC-5  no live doc keeps the contradictory "frozen, not deleted" claim
 *         (historical `docs/specs/notes/` records are deliberately excluded)
 *
 * The remote ref itself (`git ls-remote origin memory`) is a live-CI/human
 * observation — as in #247/#248 — and no in-repo test can assert it. Recorded
 * as a gap in the QA notes, not asserted here.
 *
 * This is a static policy test. Like `spec-217-docs-only-qa-gate.test.ts` and
 * the `adr-003-*` guards, it reads the repo only and never touches `dist/`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const ADR = join(REPO_ROOT, 'docs/adr/0003-memory-is-local-ci-runs-none.md');
const TEAM_SETUP = join(REPO_ROOT, 'docs/AGENT_TEAM_SETUP.md');
const MEMORY_PIPELINE = join(REPO_ROOT, 'docs/MEMORY_PIPELINE.md');

const read = (path: string): string => readFileSync(path, 'utf8');

/** The exact tip SHA the ADR promises is recoverable (a force-push target). */
const RECOVERABLE_TIP = '3c20d804';

/** Live docs that must carry the deleted-branch decision, excluding history. */
const LIVE_MEMORY_DOCS = [ADR, TEAM_SETUP, MEMORY_PIPELINE] as const;

describe('PR #249 (QA): the ADR records the deletion and the recoverable tip', () => {
  it('the ADR exists and still states the core decision', () => {
    expect(existsSync(ADR)).toBe(true);
    expect(read(ADR)).toContain('CI runs no memory machinery');
  });

  it('decision 5 says deleted (not frozen) and pins the exact tip SHA', () => {
    const adr = read(ADR);
    expect(adr).toMatch(/origin\/memory` is \*\*deleted\*\*/);
    expect(adr).not.toContain('frozen, not deleted');
    // Recoverability depends on the *actual* tip being recorded, not just any
    // hex string: the deleted branch is a force-push of this known SHA.
    expect(adr).toContain(RECOVERABLE_TIP);
  });

  it('the ADR documents where the contents were archived', () => {
    // The branch is only recoverable while the objects survive; the PR claims
    // the final contents were archived out-of-repo before deletion.
    expect(read(ADR)).toMatch(/out-of-repo/i);
  });
});

describe('PR #249 (QA): the ADR no longer offers a frozen in-repo archive', () => {
  it('the Given up paragraph reflects the deletion, not a frozen artifact', () => {
    const adr = read(ADR);
    // Old wording: "...the frozen `memory` archive ... a read-only historical
    // artifact." A re-introduction of that phrasing contradicts decision 5.
    expect(adr).not.toMatch(/frozen\s+`memory` archive/i);
    expect(adr).not.toMatch(/read-only historical artifact/i);
    // And it must say the recovery path moved out of `git fetch`.
    expect(adr).toMatch(/deleted rather than left\s+frozen/i);
  });
});

describe('PR #249 (QA): AGENT_TEAM_SETUP marks the memory branch deleted', () => {
  it('the YAAM memory table row is deleted/retired, not "Permanent"', () => {
    const row = read(TEAM_SETUP)
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes('**events.jsonl**'));
    expect(row, 'expected an events.jsonl row in the YAAM memory table').toBeDefined();
    expect(row).toMatch(/Git `memory` branch.*\(deleted\)/);
    expect(row).toContain('Retired');
    expect(row).not.toContain('Permanent');
  });

  it('the file-tree line says local daemon only, not "on memory branch"', () => {
    const line = read(TEAM_SETUP)
      .split('\n')
      .find((l) => l.includes('└── events.jsonl'));
    expect(line, 'expected an events.jsonl file-tree line').toBeDefined();
    expect(line).toContain('local daemon only');
    expect(read(TEAM_SETUP)).not.toContain('on memory branch');
  });

  it('the decision-log row retires the Git memory branch decision', () => {
    const row = read(TEAM_SETUP)
      .split('\n')
      .find((line) => line.includes('Git memory branch (not Actions cache)'));
    expect(row, 'expected the git-memory-branch decision row').toBeDefined();
    expect(row).toMatch(/~~Git memory branch \(not Actions cache\)~~/);
    expect(row).toContain('ADR-003');
  });
});

describe('PR #249 (QA): MEMORY_PIPELINE banner records the deletion', () => {
  it('the superseded banner notes the branch was deleted and the ADR holds the tip', () => {
    const raw = read(MEMORY_PIPELINE).split('## Architecture Overview')[0] ?? '';
    // Strip the blockquote markers so cross-line sentences match as prose.
    const banner = raw.replace(/^>\s?/gm, '').replace(/\s+/g, ' ');
    expect(banner).toMatch(/Superseded by \[ADR-003\]/i);
    expect(banner).toMatch(/branch itself was then deleted/i);
    expect(banner).toMatch(/tip SHA is recorded in the ADR/i);
  });
});

describe('PR #249 (QA): no live doc keeps the old frozen claim', () => {
  it.each(LIVE_MEMORY_DOCS.map((p) => p.replace(`${REPO_ROOT}/`, '')))(
    '%s does not say "frozen, not deleted"',
    (path) => {
      expect(read(join(REPO_ROOT, path))).not.toContain('frozen, not deleted');
    },
  );
});
