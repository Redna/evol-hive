/**
 * Live-sim budget guard — `scripts/live-sim.mts`
 * =============================================
 * A real-LLM sim left running is an unbounded spend. Measured: one sim ran ~16 h
 * unattended against a cloud model and made **47,808 LLM calls** (10,809 plan
 * prompts + 36,989 reflections, 295,304 log lines) — roughly 50 cloud calls a
 * minute, for no observation anyone used. Two failures produced that: the launch
 * ignored which model it was spending on, and nothing stopped it.
 *
 * So the launcher pauses the sim when its budget is spent and requires an
 * explicit continue, and it refuses to run unbounded unless that is acknowledged.
 *
 * These are behavioural tests, not content assertions: they spawn the launcher
 * with a stub command (`SIM_CMD`) so no LLM is touched, and they assert what the
 * process actually does — that the budget really stops the child early, and that
 * interrupting the wrapper leaves **no orphan**.
 *
 * The orphan check is the subtle one. The child is SIGSTOPped at the budget, and
 * a stopped process does not act on SIGTERM — it stays pending until it is
 * continued. A wrapper that only sends SIGTERM therefore leaks a stopped sim,
 * which is the exact failure mode this guard exists to prevent. Cleanup must
 * SIGCONT first.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/live-sim.mts');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** Child pid parsed out of the launcher's startup banner. */
  childPid: number | null;
  /** Wall-clock ms the wrapper took to exit — a stalled wrapper is a defect. */
  elapsedMs: number;
}

/**
 * Is a pid still running? `process.kill(pid, 0)` succeeds for a **zombie** too,
 * and a zombie spends nothing — so a reaped-but-unwaited child must not be read
 * as a runaway sim.
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

function pidFrom(text: string): number | null {
  const m = /child pid (\d+)/.exec(text);
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/**
 * Run the launcher with stubbed env. `interruptAfterMs` sends SIGINT to the
 * wrapper once the pause notice has been seen (or the timeout elapses), which is
 * how a human stops a paused sim.
 */
function runLauncher(
  env: Record<string, string>,
  timeoutMs = 30_000,
  interrupt: boolean = true,
): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    // Invoke the script DIRECTLY (node --import tsx) rather than through
    // `npx tsx`. With npx in between, `child.kill('SIGINT')` signals npm, which
    // does not forward it — so the wrapper never sees the interrupt and the test
    // silently measures a stalled process instead of the cleanup path.
    const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let interrupted = false;
    let done = false;

    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      resolvePromise({
        stdout,
        stderr,
        code,
        childPid: pidFrom(stdout),
        elapsedMs: Date.now() - startedAt,
      });
    };

    const killTimer = setTimeout(() => {
      if (!interrupted && interrupt) {
        interrupted = true;
        child.kill('SIGINT');
      }
    }, 4_000);

    const hardStop = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString();
      // Interrupt as soon as the child is paused, so the test does not wait for
      // the stub command's own (much longer) lifetime.
      if (interrupt && !interrupted && /PAUSED after/.test(stdout)) {
        interrupted = true;
        setTimeout(() => child.kill('SIGINT'), 100);
      }
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(hardStop);
      finish(code);
    });
  });
}

/** Give the OS a moment to reap, then check for orphans. */
async function eventually(predicate: () => boolean, ms = 3_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

describe('live-sim budget guard (scripts/live-sim.mts)', () => {
  it('exists and defaults to a bounded, cloud-acknowledged run', () => {
    expect(existsSync(SCRIPT), 'scripts/live-sim.mts must exist').toBe(true);
    const src = readFileSync(SCRIPT, 'utf8');
    // The two facts an operator must not have to rediscover: which model, and
    // that a budget exists.
    expect(src).toMatch(/gemma4:31b-cloud/);
    expect(src).toMatch(/SIM_BUDGET_MINUTES/);
  });

  it('pauses the child when the budget is spent, and says how to continue', async () => {
    const result = await runLauncher({
      SIM_CMD: 'sleep 60',
      SIM_BUDGET_MINUTES: '0.03', // ~1.8s
    });

    expect(result.stdout).toMatch(/PAUSED after/);
    expect(result.stdout).toMatch(/kill -CONT/);
    expect(result.childPid, 'the launcher must report the child pid').not.toBeNull();
    // It must have paused while the stub was still alive — i.e. the budget, not
    // the command's own exit, ended the wait.
    expect(result.stdout).not.toMatch(/child exited/);
    // And the wrapper must actually act on the interrupt. Without this, a
    // wrapper that ignores SIGINT still passes the assertions above while
    // running until the test's hard timeout — which is how the npx indirection
    // hid a leaked child.
    expect(result.elapsedMs, 'wrapper did not shut down promptly on SIGINT').toBeLessThan(15_000);
  }, 40_000);

  it('leaves no orphan when the wrapper is interrupted while paused', async () => {
    const result = await runLauncher({
      SIM_CMD: 'sleep 60',
      SIM_BUDGET_MINUTES: '0.03',
    });
    const pid = result.childPid;
    expect(pid, 'need a child pid to check for orphans').not.toBeNull();

    // A stopped process ignores SIGTERM until continued, so this fails unless
    // cleanup sends SIGCONT first.
    const gone = await eventually(() => !alive(pid!));
    if (!gone) {
      try {
        process.kill(pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    expect(gone, `child ${pid} was left running after the wrapper was interrupted`).toBe(true);
  }, 40_000);

  it('refuses to run unbounded unless that is explicitly acknowledged', async () => {
    const result = await runLauncher(
      { SIM_CMD: 'sleep 60', SIM_BUDGET_MINUTES: '0' },
      20_000,
      false,
    );
    expect(`${result.stdout}${result.stderr}`).toMatch(/REFUSING/);
    expect(result.code).not.toBe(0);
  }, 40_000);
});
