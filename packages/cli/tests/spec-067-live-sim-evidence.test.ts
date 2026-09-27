/**
 * Spec 067 — A Live Run Must Leave Evidence (issue #270), leg 1
 * ─────────────────────────────────────────────────────────────
 * `scripts/live-sim.mts` is where a *spending* run is admitted, so it is where
 * the evidence rule belongs (spec 067 R1, Decision 2). For a `USE_REAL_LLM=true`
 * launch it must:
 *
 *   - print the evidence destination in the banner, next to model + budget (R3);
 *   - pass `SYSTEM1_SESSION_LOG_DIR` to the child so the sink is real (AC-9);
 *   - refuse to start when the run cannot write samples, unless an explicit
 *     acknowledgement flag is set (AC-3).
 *
 * A `USE_REAL_LLM=false` run is cheap and deterministic: it does not get a
 * forced directory (AC-4).
 *
 * Behavioural, not content: every test spawns the launcher with a stub
 * `SIM_CMD`, so no LLM is ever contacted. The docs guard asserts the corrected
 * statements exist and the stale unconditional claim is gone (AC-8); the
 * precedent for a docs guard is `adr-003-ci-memory-scope.test.ts`.
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
}

/** Drop any ambient sim/LLM/evidence env so each test owns its configuration. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(SIM_|LLM_MODEL|USE_REAL_LLM|SYSTEM1_)/.test(key)) delete env[key];
  }
  return env;
}

/** Run the launcher once (with the stub command) and wait for it to exit. */
function runLauncher(env: Record<string, string>, timeoutMs = 20_000): Promise<RunResult> {
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
    child.on('exit', (code) => {
      clearTimeout(hardStop);
      resolvePromise({ stdout, stderr, code });
    });
  });
}

describe('spec 067 AC-2/AC-9 — the launcher configures and announces an evidence sink', () => {
  it('passes the default session-logs directory to the child and prints it', async () => {
    const result = await runLauncher({
      SIM_CMD: 'echo CHILD_EVIDENCE=[$SYSTEM1_SESSION_LOG_DIR]',
    });
    expect(result.stdout).toContain('evidence=session-logs');
    expect(result.stdout).toContain('CHILD_EVIDENCE=[session-logs]');
    expect(result.code).toBe(0);
  }, 30_000);

  it('honours SYSTEM1_SESSION_LOG_DIR as the override', async () => {
    const result = await runLauncher({
      SIM_CMD: 'echo CHILD_EVIDENCE=[$SYSTEM1_SESSION_LOG_DIR]',
      SYSTEM1_SESSION_LOG_DIR: '/tmp/evol-hive-evidence-067',
    });
    expect(result.stdout).toContain('evidence=/tmp/evol-hive-evidence-067');
    expect(result.stdout).toContain('CHILD_EVIDENCE=[/tmp/evol-hive-evidence-067]');
  }, 30_000);

  it('does not force a directory on a cheap USE_REAL_LLM=false run', async () => {
    const result = await runLauncher({
      SIM_CMD: 'echo CHILD_EVIDENCE=[$SYSTEM1_SESSION_LOG_DIR]',
      USE_REAL_LLM: 'false',
    });
    expect(result.stdout).toContain('evidence=none');
    expect(result.stdout).toContain('CHILD_EVIDENCE=[]');
    expect(result.code).toBe(0);
  }, 30_000);
});

describe('spec 067 AC-3 — the launcher refuses a spending run with no sink', () => {
  it('refuses a real-LLM run whose evidence directory is blank, before launching', async () => {
    const result = await runLauncher({
      SIM_CMD: 'echo SHOULD_NOT_RUN',
      SYSTEM1_SESSION_LOG_DIR: '',
    });
    expect(`${result.stdout}${result.stderr}`).toMatch(/REFUSING/);
    expect(`${result.stdout}${result.stderr}`).toMatch(/sample sink/i);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('[live-sim] child pid');
    expect(result.stdout).not.toContain('SHOULD_NOT_RUN');
  }, 30_000);

  it('launches when the operator explicitly acknowledges running without evidence', async () => {
    const result = await runLauncher({
      SIM_CMD: 'echo CHILD_STARTED',
      SYSTEM1_SESSION_LOG_DIR: '',
      SIM_NO_EVIDENCE: '1',
    });
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/REFUSING/);
    expect(result.stdout).toContain('CHILD_STARTED');
    expect(result.code).toBe(0);
  }, 30_000);

  it('does not refuse a cheap run even with a blank evidence directory', async () => {
    const result = await runLauncher({
      SIM_CMD: 'echo CHILD_STARTED',
      USE_REAL_LLM: 'false',
      SYSTEM1_SESSION_LOG_DIR: '',
    });
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/REFUSING/);
    expect(result.code).toBe(0);
  }, 30_000);
});

// ── AC-8: the documentation states the rule ──────────────────────────────────

describe('spec 067 AC-8 — docs state which paths write samples and how to opt in', () => {
  const agents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
  const delivery = readFileSync(join(REPO_ROOT, 'docs/DELIVERY_PROCEDURE.md'), 'utf8');

  it('AGENTS.md drops the stale unconditional claim', () => {
    expect(agents).not.toMatch(/live sims write outcome samples to/i);
  });

  it('AGENTS.md names the opting-in paths and the env var', () => {
    for (const needle of [
      'sessionLogDir',
      'SYSTEM1_SESSION_LOG_DIR',
      'examples/visualizer-demo.ts',
      'examples/dynamic-world-sim.ts',
      'examples/coffee-shop.ts',
      'USE_REAL_LLM=false',
      'scripts/live-sim.mts',
    ]) {
      expect(agents, `AGENTS.md must mention ${needle}`).toContain(needle);
    }
  });

  it('DELIVERY_PROCEDURE.md makes an evidence sink part of the live-validation step', () => {
    for (const needle of ['SYSTEM1_SESSION_LOG_DIR', 'evidence=<dir>', 'SIM_NO_EVIDENCE=1']) {
      expect(delivery, `DELIVERY_PROCEDURE.md must mention ${needle}`).toContain(needle);
    }
  });
});
