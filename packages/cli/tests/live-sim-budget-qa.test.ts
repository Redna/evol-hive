/**
 * QA companion for PR #269 — `scripts/live-sim.mts` spend guard.
 *
 * There is no spec document for this change (it is a tooling/docs PR); the
 * reference contract is the PR body plus the two documents it edits
 * (`AGENTS.md` safety rule, `docs/DELIVERY_PROCEDURE.md` step 5). The
 * developer's `live-sim-budget.test.ts` already covers the three hardest
 * behaviours: the budget pause, the SIGCONT-then-SIGTERM no-orphan cleanup, and
 * the unbounded refusal.
 *
 * This file closes the acceptance criteria those tests leave unverified:
 *
 *   - the startup banner names the model and the budget *before* the child
 *     starts (PR body: "Prints the model and budget before starting");
 *   - a `:cloud` model draws the quota warning (PR body: "warns on a `:cloud`
 *     model"), and a local model does not;
 *   - `LLM_MODEL` (and `USE_REAL_LLM`) actually reach the child env, not just
 *     the banner (PR body: "`LLM_MODEL` overrides");
 *   - the acknowledged-unbounded positive branch runs (`SIM_UNBOUNDED=1` with a
 *     zero budget), so the refusal is not an unconditional block;
 *   - a malformed budget is refused before any child is launched;
 *   - interrupting a paused wrapper kills the whole process group, so a
 *     grandchild (the shape of `npm exec tsx`) does not survive — the developer
 *     test only checks the direct child pid;
 *   - `AGENTS.md` / `DELIVERY_PROCEDURE.md` point at the launcher, including the
 *     40-minute live-validation case (PR body: Docs).
 *
 * Behavioural, not content: every test spawns the script with a stub `SIM_CMD`
 * so no LLM is ever contacted. `USE_REAL_LLM` is forced where relevant.
 *
 * Known gap (recorded in the QA report, not asserted here because it is a real
 * defect): the default model `gemma4:31b-cloud` does **not** match the guard's
 * `model.includes(':cloud')` test, so the default cloud model draws no quota
 * warning.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/live-sim.mts');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Drop any ambient sim/LLM env so the tests own the configuration. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(SIM_|LLM_MODEL|USE_REAL_LLM)/.test(key)) delete env[key];
  }
  return env;
}

/** Run the launcher once and wait for it to exit. */
function runScript(env: Record<string, string>, timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...cleanEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const hardStop = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    child.on('exit', (code, signal) => {
      clearTimeout(hardStop);
      resolvePromise({ stdout, stderr, code, signal });
    });
  });
}

/**
 * Is a pid still running? `process.kill(pid, 0)` also answers true for a
 * **zombie**, which spends nothing — so a reaped-but-unwaited child must not be
 * read as a runaway sim.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    return stat.slice(end + 2, end + 3) !== 'Z';
  } catch {
    return false; // no /proc entry → gone
  }
}

async function eventually(predicate: () => boolean, ms = 5_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

interface PausedRunResult extends RunResult {
  childPid: number | null;
  grandchildPid: number | null;
}

/**
 * Run the launcher, wait for the budget pause notice, then send SIGINT to the
 * wrapper — what Ctrl-C does. Returns the direct child and any grandchild pid the
 * stub reported.
 */
function runPausedAndInterrupt(
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<PausedRunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...cleanEnv(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let interrupted = false;
    let done = false;
    const pidOf = (re: RegExp): number | null => {
      const m = re.exec(stdout);
      return m?.[1] !== undefined ? Number(m[1]) : null;
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      clearTimeout(hardStop);
      resolvePromise({
        stdout,
        stderr,
        code,
        signal,
        childPid: pidOf(/child pid (\d+)/),
        grandchildPid: pidOf(/GRANDCHILD_PID=(\d+)/),
      });
    };
    const hardStop = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString();
      // Interrupt as soon as the child is paused, so the test does not wait for
      // the stub command's own (much longer) lifetime.
      if (!interrupted && /PAUSED after/.test(stdout)) {
        interrupted = true;
        setTimeout(() => child.kill('SIGINT'), 100);
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

describe('PR #269 QA — live-sim startup banner', () => {
  it('prints the model and budget before the child starts, with the default 30-minute budget', async () => {
    const result = await runScript({ SIM_CMD: 'echo CHILD_STARTED' });
    const combined = `${result.stdout}${result.stderr}`;

    expect(combined).toContain('[live-sim] model=gemma4:31b-cloud budget=30 min realLlm=true');

    const bannerAt = result.stdout.indexOf('[live-sim] model=');
    const childAt = result.stdout.indexOf('[live-sim] child pid');
    expect(bannerAt, 'the model/budget banner must be printed').toBeGreaterThanOrEqual(0);
    expect(childAt, 'the child launch line must follow the banner').toBeGreaterThan(bannerAt);
    expect(result.code).toBe(0);
  }, 30_000);

  it('warns that a :cloud model spends quota', async () => {
    const result = await runScript({
      SIM_CMD: 'echo hi',
      LLM_MODEL: 'deepseek-v4.1-flash:cloud',
    });
    expect(result.stdout).toContain('model=deepseek-v4.1-flash:cloud');
    expect(result.stdout).toContain('NOTE: a cloud model spends quota');
  }, 30_000);

  it('does not print the cloud warning for a local model', async () => {
    const result = await runScript({
      SIM_CMD: 'echo hi',
      LLM_MODEL: 'llama3.2:8b',
    });
    expect(result.stdout).toContain('model=llama3.2:8b');
    expect(result.stdout).not.toContain('NOTE: a cloud model');
  }, 30_000);
});

describe('PR #269 QA — env routing and refusal edges', () => {
  it('passes the LLM_MODEL override and USE_REAL_LLM through to the child', async () => {
    const result = await runScript({
      SIM_CMD: 'echo CHILD_MODEL=$LLM_MODEL CHILD_REAL=$USE_REAL_LLM',
      LLM_MODEL: 'override-model:cloud',
      USE_REAL_LLM: 'false',
    });
    expect(result.stdout).toContain('CHILD_MODEL=override-model:cloud');
    expect(result.stdout).toContain('CHILD_REAL=false');
  }, 30_000);

  it('runs the acknowledged-unbounded branch (SIM_UNBOUNDED=1, budget 0)', async () => {
    const result = await runScript({
      SIM_CMD: 'echo CHILD_STARTED',
      SIM_BUDGET_MINUTES: '0',
      SIM_UNBOUNDED: '1',
    });
    const combined = `${result.stdout}${result.stderr}`;
    expect(result.stdout).toContain('budget=UNBOUNDED (acknowledged)');
    expect(combined).not.toContain('REFUSING');
    expect(result.code).toBe(0);
  }, 30_000);

  it('refuses a non-numeric or negative budget before launching anything', async () => {
    for (const bad of ['abc', '-5']) {
      const result = await runScript({ SIM_CMD: 'echo SHOULD_NOT_RUN', SIM_BUDGET_MINUTES: bad });
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined, `budget=${bad} must be refused`).toMatch(/REFUSING/);
      expect(result.code, `budget=${bad} must exit non-zero`).not.toBe(0);
      expect(result.stdout).not.toContain('[live-sim] child pid');
    }
  }, 30_000);
});

describe('PR #269 QA — process-group cleanup reaches grandchildren', () => {
  it('kills the whole process group on interrupt, not just the direct child', async () => {
    const result = await runPausedAndInterrupt({
      // Forks a grandchild (as `npm exec tsx` does) and waits on it.
      SIM_CMD: 'sleep 60 & echo GRANDCHILD_PID=$!; wait',
      SIM_BUDGET_MINUTES: '0.03',
    });

    const grandchild = result.grandchildPid;
    expect(grandchild, 'the stub must report its grandchild pid').not.toBeNull();
    expect(result.stdout).toContain('PAUSED after');

    const gone = await eventually(() => !alive(grandchild!));
    if (!gone) {
      // Best-effort cleanup so a failure cannot leak a real orphan.
      try {
        process.kill(grandchild!, 'SIGKILL');
      } catch {
        /* already gone */
      }
      if (result.childPid !== null) {
        try {
          process.kill(-result.childPid, 'SIGKILL');
        } catch {
          /* group already gone */
        }
      }
    }
    expect(gone, `grandchild ${grandchild} outlived the wrapper — group kill leaked`).toBe(true);
  }, 40_000);
});

describe('PR #269 QA — documentation points at the launcher', () => {
  const agents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
  const delivery = readFileSync(join(REPO_ROOT, 'docs/DELIVERY_PROCEDURE.md'), 'utf8');

  it('AGENTS.md points live sims at the launcher and names the budget controls', () => {
    expect(agents).toContain('scripts/live-sim.mts');
    expect(agents).toMatch(/30-minute budget/);
    expect(agents).toContain('SIM_BUDGET_MINUTES');
    expect(agents).toContain('SIM_UNBOUNDED=1');
  });

  it('DELIVERY_PROCEDURE.md points at the launcher and shows the 40-minute live-validation case', () => {
    expect(delivery).toContain('scripts/live-sim.mts');
    expect(delivery).toContain('SIM_BUDGET_MINUTES=40');
  });
});
