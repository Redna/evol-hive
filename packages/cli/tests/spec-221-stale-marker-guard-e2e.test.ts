/**
 * Issue #221 fault 3 QA coverage — stale YAAM marker must fail loudly, not
 * silently save nothing.
 * ============================================================================
 * PR #240 (`221-stale-marker-guard`) changes `scripts/save-memory.sh` and
 * `scripts/restore-memory.sh`. There is no spec document for this change; the
 * reference acceptance criteria are the draft ACs in issue #221. This file
 * locks down the criteria the PR actually claims to deliver:
 *
 *   AC-2 — `save-memory.sh` pushes a NON-EMPTY delta for a run that wrote
 *          events (`NEW_LINES > 0` asserted, not assumed), and the artifact on
 *          the `memory` branch contains it.
 *   AC-3 — a stale marker (store reset/replaced after restore) must fail
 *          loudly instead of silently saving nothing (the concrete path
 *          mismatch this PR diagnoses), and the marker self-heals.
 *   AC-7 — one grep-able `[yaam] …` diagnostic per run, from logs alone.
 *
 * The scripts are executed end-to-end against throwaway git repos and a bare
 * remote, so the assertions exercise the real shell, not a re-implementation.
 * Every temp repo/worktree is removed afterwards. `dist/` is never touched.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';

const REPO_ROOT = resolve(__dirname, '../../..');
const SAVE_SCRIPT = join(REPO_ROOT, 'scripts/save-memory.sh');
const RESTORE_SCRIPT = join(REPO_ROOT, 'scripts/restore-memory.sh');

const CLEANUP_DIRS: string[] = [];
// The scripts use a fixed worktree path; remove any leftover from a prior run.
const SCRIPT_WORKTREE = '/tmp/yaam-memory-worktree';

afterAll(() => {
  for (const dir of CLEANUP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(SCRIPT_WORKTREE, { recursive: true, force: true });
});

/** Env without inherited git/CI overrides so the scripts take the local path. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: 'false', ...extra };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];
  delete env['GIT_PREFIX'];
  return env;
}

function makeTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spec221-'));
  CLEANUP_DIRS.push(dir);
  return dir;
}

/** Run a bash script from `cwd`, returning the combined status/stdout/stderr. */
function runScript(
  script: string,
  cwd: string,
  opts: { env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [script], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(opts.env),
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Write an `events.jsonl` file with one line per array entry (empty → 0 lines). */
function writeEvents(dir: string, lines: string[]): void {
  const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  writeFileSync(join(dir, 'events.jsonl'), body);
}

function writeMarker(dir: string, value: string): void {
  writeFileSync(join(dir, '.yaam_start_lines'), `${value}\n`);
}

function readMarker(dir: string): string {
  return readFileSync(join(dir, '.yaam_start_lines'), 'utf8').trim();
}

interface Sandbox {
  repo: string;
  bare: string;
}

/**
 * A throwaway repo with an `origin` bare remote and an existing `memory`
 * branch carrying `memoryFiles` (string or raw Buffer). The workspace is left
 * on a clean `main` checkout.
 */
function setupSandbox(memoryFiles: Record<string, string | Buffer>): Sandbox {
  const repo = makeTemp();
  const bare = makeTemp();

  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'qa@test.local'], repo);
  git(['config', 'user.name', 'qa'], repo);
  writeFileSync(join(repo, 'README.md'), 'seed\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'init'], repo);

  git(['init', '-q', '--bare', bare], repo);
  git(['remote', 'add', 'origin', bare], repo);

  git(['checkout', '-q', '-b', 'memory'], repo);
  for (const [name, content] of Object.entries(memoryFiles)) {
    writeFileSync(join(repo, name), content);
  }
  git(['add', '-A'], repo);
  // `--allow-empty` keeps the branch creatable when the caller supplies no
  // memory files (the "no new events" scenario).
  git(['commit', '-qm', 'memory', '--allow-empty'], repo);
  git(['push', '-q', 'origin', 'memory'], repo);
  git(['checkout', '-q', 'main'], repo);

  return { repo, bare };
}

const GZIP_LINES = (lines: string[]): Buffer => gzipSync(Buffer.from(`${lines.join('\n')}\n`));

describe('spec 221 fault 3 — save-memory.sh stale/invalid/empty marker', () => {
  it('stale marker (start > current) fails loudly, re-baselines, and pushes nothing', () => {
    const dir = makeTemp();
    writeEvents(dir, ['a', 'b', 'c']);
    writeMarker(dir, '999');

    const run = runScript(SAVE_SCRIPT, dir);

    expect(run.status, run.stderr).toBe(0);
    // AC-7: one grep-able diagnostic naming the stale condition.
    expect(run.stdout).toContain('[yaam] saved=0 reason=stale-marker start=999 current=3');
    expect(run.stdout).toContain('STALE MARKER');
    // The old silent no-op is gone: the reason is explicit.
    expect(run.stdout).not.toContain('No new events to save.');
    // AC-3: self-heal — the NEXT save is correct.
    expect(readMarker(dir)).toBe('3');
    // No git repo exists here, so if the script had tried to push it would have
    // failed; the exit 0 proves it short-circuited.
    expect(existsSync(join(dir, 'events-999.jsonl'))).toBe(false);
  });

  it('self-heals: a second run of the same store reports no-new-events, not stale', () => {
    const dir = makeTemp();
    writeEvents(dir, ['a', 'b', 'c']);
    writeMarker(dir, '999');

    runScript(SAVE_SCRIPT, dir);
    const second = runScript(SAVE_SCRIPT, dir, { env: { GITHUB_RUN_ID: '22102' } });

    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('[yaam] saved=0 reason=no-new-events start=3 current=3');
    expect(second.stdout).not.toContain('STALE MARKER');
  });

  it('rejects a non-numeric marker, warns, and treats it as 0 (AC-7)', () => {
    const dir = makeTemp();
    writeEvents(dir, []);
    writeMarker(dir, 'not-a-number');

    const run = runScript(SAVE_SCRIPT, dir);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("[yaam] marker-invalid start='not-a-number' — treating as 0");
    expect(run.stdout).toContain('[yaam] saved=0 reason=no-new-events start=0 current=0');
  });

  it('rejects an empty marker file and treats it as 0 (AC-7)', () => {
    const dir = makeTemp();
    writeEvents(dir, []);
    writeFileSync(join(dir, '.yaam_start_lines'), '');

    const run = runScript(SAVE_SCRIPT, dir);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("[yaam] marker-invalid start='' — treating as 0");
  });

  it('an empty delta keeps the quiet no-new-events path (no false alarm)', () => {
    const dir = makeTemp();
    writeEvents(dir, ['a', 'b']);
    writeMarker(dir, '2');

    const run = runScript(SAVE_SCRIPT, dir);

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('[yaam] saved=0 reason=no-new-events start=2 current=2');
    expect(run.stdout).not.toContain('STALE MARKER');
  });
});

describe('spec 221 AC-2 — a non-empty delta reaches the memory branch', () => {
  it('pushes exactly the new lines as a delta and reports saved>0', () => {
    const { repo, bare } = setupSandbox({ 'events.jsonl': 'old1\nold2\n' });

    const existing = ['l1', 'l2', 'l3', 'l4'];
    const fresh = ['l5', 'l6'];
    writeEvents(repo, [...existing, ...fresh]);
    writeMarker(repo, String(existing.length));

    const run = runScript(SAVE_SCRIPT, repo, { env: { GITHUB_RUN_ID: '22101' } });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('[yaam] saving=2 start=4 current=6');
    expect(run.stdout).toContain('Memory pushed successfully.');
    expect(run.stdout).toContain('[yaam] saved=2 run=22101');

    // The artifact exists on the memory branch and holds exactly the new lines.
    const pushed = git(['--git-dir', bare, 'show', 'memory:events-22101.jsonl'], repo);
    expect(pushed).toBe('l5\nl6');
    // It must not re-push the whole store (the wrong-slice failure mode).
    expect(pushed).not.toContain('l1');
    expect(pushed).not.toContain('old1');
  });

  it('does not push a delta file when the store has no new events', () => {
    const { repo, bare } = setupSandbox({});
    writeEvents(repo, ['a', 'b']);
    writeMarker(repo, '2');

    const run = runScript(SAVE_SCRIPT, repo, { env: { GITHUB_RUN_ID: '22103' } });

    expect(run.status, run.stderr).toBe(0);
    const files = git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'memory'], repo);
    expect(files).not.toContain('events-22103.jsonl');
  });
});

describe('spec 221 AC-7 — restore-memory.sh diagnostic + round trip', () => {
  it('restores a gzip base, reports the count, and re-baselines the marker', () => {
    const base = ['e1', 'e2', 'e3', 'e4', 'e5'];
    const { repo } = setupSandbox({ 'events.jsonl.gz': GZIP_LINES(base) });

    // A stale local store + marker, like the box in the issue.
    writeFileSync(join(repo, 'events.jsonl'), 'stale\n');
    writeMarker(repo, '42');

    const run = runScript(RESTORE_SCRIPT, repo, { env: { GITHUB_RUN_ID: '22104' } });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('[yaam] restored=5 events size=');
    expect(run.stdout).toContain('run=22104');
    expect(readMarker(repo)).toBe('5');
    expect(readFileSync(join(repo, 'events.jsonl'), 'utf8')).toBe(`${base.join('\n')}\n`);
  });

  it('merges a gzip base with a delta in chronological order (AC-2 restore side)', () => {
    const baseLines = ['b1', 'b2', 'b3'];
    const deltaLines = ['d1', 'd2'];
    const { repo } = setupSandbox({
      'events.jsonl.gz': GZIP_LINES(baseLines),
      'events-111.jsonl': `${deltaLines.join('\n')}\n`,
    });

    const run = runScript(RESTORE_SCRIPT, repo, { env: { GITHUB_RUN_ID: '22105' } });

    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('[yaam] restored=5 events size=');
    expect(readFileSync(join(repo, 'events.jsonl'), 'utf8')).toBe(
      `${[...baseLines, ...deltaLines].join('\n')}\n`,
    );
    expect(readMarker(repo)).toBe('5');
    // The merged store survives and the delta files are cleaned from the workspace.
    expect(existsSync(join(repo, 'events.jsonl'))).toBe(true);
    expect(readdirSync(repo).filter((f) => /^events-.*\.jsonl$/.test(f))).toEqual([]);
  });

  it('restore → save round trip reports no-new-events, not a stale false positive', () => {
    const base = ['x1', 'x2', 'x3'];
    const { repo } = setupSandbox({ 'events.jsonl.gz': GZIP_LINES(base) });

    const restore = runScript(RESTORE_SCRIPT, repo, { env: { GITHUB_RUN_ID: '22106' } });
    expect(restore.status, restore.stderr).toBe(0);
    expect(readMarker(repo)).toBe('3');

    const save = runScript(SAVE_SCRIPT, repo, { env: { GITHUB_RUN_ID: '22106' } });
    expect(save.status, save.stderr).toBe(0);
    expect(save.stdout).toContain('[yaam] saved=0 reason=no-new-events start=3 current=3');
    expect(save.stdout).not.toContain('STALE MARKER');
  });
});

describe('spec 221 — script hygiene', () => {
  it.each([SAVE_SCRIPT, RESTORE_SCRIPT])('is syntactically valid bash: %s', (script) => {
    const run = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });

  it('emits the AC-7 save diagnostic markers from the script text', () => {
    const text = readFileSync(SAVE_SCRIPT, 'utf8');
    // The reason taxonomy is explicit in the source (stale vs empty vs saving).
    expect(text).toContain('reason=stale-marker');
    expect(text).toContain('reason=no-new-events');
    expect(text).toContain('[yaam] saving=');
    expect(text).toContain('[yaam] saved=');
  });

  it('emits the AC-7 restore diagnostic from the script text', () => {
    const text = readFileSync(RESTORE_SCRIPT, 'utf8');
    expect(text).toContain('[yaam] restored=');
  });
});
