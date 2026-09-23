/**
 * PR #248 QA coverage — the CI-only YAAM branch-sync toolchain is dropped
 * ============================================================================
 * This PR is a follow-up to #247 correcting ADR-003 decision 4: the
 * branch-sync scripts were never "local tooling", they existed only to move
 * `events.jsonl` through the `memory` branch for GitHub Actions, so they are
 * deleted rather than retained. The reference contract is the ADR
 * (`docs/adr/0003-memory-is-local-ci-runs-none.md`) plus the PR body's
 * knock-on claims; there is no feature spec (harness change — the same
 * precedent as #247).
 *
 * The developer inverted its guard in `adr-003-ci-memory-scope.test.ts` to
 * assert the five shell/JS scripts are gone and that nothing left under
 * `scripts/` drives the `memory` branch. QA found the PR's remaining claims
 * unguarded and locks them here:
 *
 *   AC-1  the two unreferenced analysis scripts (`.py`, operator-home paths)
 *         are deleted as well — they are not in the ADR's five-script list
 *   AC-2  `scripts/pipeline.sh` Phase 6 (Memory Compaction) is removed, Phases
 *         1–5 are intact, and the script is still syntactically valid
 *   AC-3  `spec-221-stale-marker-guard-e2e.test.ts` is deleted with the scripts
 *   AC-4  `events.jsonl.bak*` *actually* ignores replay backups, not just the
 *         pattern text — verified through git, not a substring match
 *   AC-5  the in-engine memory the ADR calls "unchanged" still exists
 *   AC-6  no workflow, script or top-level prompt carries a live reference to
 *         a deleted file (the ADR and docs are deliberate historical records)
 *
 * This is a static policy test. Like `spec-217-docs-only-qa-gate.test.ts` and
 * the two `adr-003-*` guards, it reads the repo, never `dist/`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github/workflows');
const AGENTS_DIR = join(REPO_ROOT, '.pi/agents');
const TASKS_DIR = join(REPO_ROOT, '.pi/tasks');
const PIPELINE = join(SCRIPTS_DIR, 'pipeline.sh');

/** Every file this PR deleted, across both the shell/JS toolchain and the Python helpers. */
const DELETED_FILES = [
  'scripts/restore-memory.sh',
  'scripts/save-memory.sh',
  'scripts/run-compaction.sh',
  'scripts/compact.js',
  'scripts/compact-stream.js',
  'scripts/analyze-memory.py',
  'scripts/analyze-entities.py',
] as const;

/** The Phase 6 header and everything it used to call. */
const PHASE_6_MARKERS = [
  /PHASE\s*6/i,
  /Memory Compaction/i,
  /run-compaction/,
  /refs\/remotes\/origin\/memory/,
  /origin memory:/,
];

function filesNamed(dir: string, predicate: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && predicate(e.name))
    .map((e) => e.name);
}

/** Every file under `scripts/` — the toolchain spans shell, JS/MJS/MTS, JSON and Python. */
function scriptFiles(): { path: string; body: string }[] {
  return filesNamed(SCRIPTS_DIR, () => true).map((f) => ({
    path: `scripts/${f}`,
    body: readFileSync(join(SCRIPTS_DIR, f), 'utf8'),
  }));
}

/** The top-level agent + task prompts (feature task dirs and `.pi/notes/` are history). */
function topLevelPrompts(): { path: string; body: string }[] {
  const agents = filesNamed(AGENTS_DIR, (n) => n.endsWith('.md')).map((f) => ({
    path: `.pi/agents/${f}`,
    body: readFileSync(join(AGENTS_DIR, f), 'utf8'),
  }));
  const tasks = filesNamed(TASKS_DIR, (n) => n.endsWith('.md')).map((f) => ({
    path: `.pi/tasks/${f}`,
    body: readFileSync(join(TASKS_DIR, f), 'utf8'),
  }));
  return [...agents, ...tasks];
}

describe('ADR-003 follow-up (QA): the whole toolchain is gone', () => {
  for (const file of DELETED_FILES) {
    it(`${file} is deleted`, () => {
      expect(existsSync(join(REPO_ROOT, file))).toBe(false);
    });
  }

  it('no script leaks an operator-home absolute path again', () => {
    // `analyze-memory.py` / `analyze-entities.py` hardcoded an operator's
    // home directory in a public repo. Nothing under scripts/ should ever
    // carry an absolute /home/<user>/ path.
    const offenders = scriptFiles()
      .filter(({ body }) => /\/home\/[a-z0-9._-]+\//i.test(body))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

describe('ADR-003 follow-up (QA): pipeline.sh Phase 6 is removed, Phases 1–5 intact', () => {
  const pipeline = readFileSync(PIPELINE, 'utf8');

  it('the pipeline is still syntactically valid bash', () => {
    const run = spawnSync('bash', ['-n', PIPELINE], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });

  it.each([
    'PHASE 1: ARCHITECT',
    'PHASE 2: WAIT FOR SPEC PR MERGE',
    'PHASE 3: DEVELOPER',
    'PHASE 4: CI + QA',
    'PHASE 5: WAIT FOR CODE PR MERGE',
  ])('keeps the %s phase header', (header) => {
    expect(pipeline).toContain(header);
  });

  it('does not run or reference the deleted compaction phase', () => {
    for (const marker of PHASE_6_MARKERS) {
      expect(pipeline).not.toMatch(marker);
    }
  });
});

describe('ADR-003 follow-up (QA): spec-221 test went with its scripts', () => {
  it('spec-221-stale-marker-guard-e2e.test.ts is deleted', () => {
    expect(
      existsSync(join(REPO_ROOT, 'packages/cli/tests/spec-221-stale-marker-guard-e2e.test.ts')),
    ).toBe(false);
  });
});

describe('ADR-003 follow-up (QA): replay backups are really ignored', () => {
  it('git ignores events.jsonl.bak and timestamped replay backups', () => {
    // Check through git itself, not a regex on `.gitignore`: the pattern must
    // match the 229 MB `events.jsonl.bak<date>` replay backups, not only the
    // bare suffix, or an operator can still `git add` them.
    const run = spawnSync(
      'git',
      [
        'check-ignore',
        '-v',
        'events.jsonl.bak',
        'events.jsonl.bak.2026-09-22',
        'events.jsonl.bak.old',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('events.jsonl.bak');
    expect(run.stdout).toContain('events.jsonl.bak.2026-09-22');
    expect(run.stdout).toContain('events.jsonl.bak.old');
  });

  it('the daemon log itself stays ignored', () => {
    const run = spawnSync('git', ['check-ignore', 'events.jsonl'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
  });
});

describe('ADR-003 follow-up (QA): the in-engine memory the ADR calls unchanged', () => {
  it.each([
    'packages/memory/src/index.ts',
    'packages/engine/src/world/mutations/yaam-event-log.ts',
  ])('%s still exists', (file) => {
    expect(existsSync(join(REPO_ROOT, file))).toBe(true);
  });
});

describe('ADR-003 follow-up (QA): no live references to a deleted file', () => {
  it('no workflow, script or top-level prompt names a deleted toolchain file', () => {
    const workflowFiles = filesNamed(WORKFLOWS_DIR, (n) => /\.ya?ml$/.test(n)).map((f) => ({
      path: `.github/workflows/${f}`,
      body: readFileSync(join(WORKFLOWS_DIR, f), 'utf8'),
    }));
    const offenders: string[] = [];
    for (const { path, body } of [...workflowFiles, ...scriptFiles(), ...topLevelPrompts()]) {
      for (const deleted of DELETED_FILES) {
        // Match the basename so both `scripts/foo` and a bare `foo` are caught.
        const base = deleted.replace('scripts/', '');
        if (body.includes(base)) offenders.push(`${path} → ${base}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
