#!/usr/bin/env -S npx tsx
/**
 * scripts/live-sim.mts — launch a real-LLM sim with a spend budget.
 * =================================================================
 * A live sim is an open-ended spend: every agent cycle is an LLM call. Measured
 * on this repo, one sim left running unattended for ~16 h made **47,808 calls**
 * (10,809 plan prompts + 36,989 reflections over 295,304 log lines) — about 50
 * cloud calls a minute, and nobody read the result. The run also quietly used a
 * different model than the operator expected, because the launch env said so.
 *
 * This wrapper exists so neither can happen silently:
 *
 *   - it prints the MODEL and the BUDGET before anything starts;
 *   - it PAUSES the sim when the budget is spent and requires an explicit
 *     continue, rather than running until someone notices;
 *   - it REFUSES to run unbounded unless that is acknowledged on purpose;
 *   - it cleans up the whole process group on Ctrl-C, including a stopped child
 *     (a stopped process ignores SIGTERM until it is continued, which is how an
 *     orphaned sim survives a naive wrapper).
 *
 * Usage:
 *   npx tsx scripts/live-sim.mts                      # 30 min budget, gemma
 *   SIM_BUDGET_MINUTES=10 npx tsx scripts/live-sim.mts
 *   SIM_UNBOUNDED=1 npx tsx scripts/live-sim.mts      # deliberate opt-out
 *   LLM_MODEL=deepseek-v4.1-flash:cloud npx tsx scripts/live-sim.mts
 *
 * Env:
 *   LLM_MODEL           default `gemma4:31b-cloud` (the operator's choice)
 *   SIM_BUDGET_MINUTES  default 30; 0/absent-with-opt-out means unbounded
 *   SIM_UNBOUNDED=1     acknowledge an unbounded run
 *   SIM_CMD             override the launched command (used by the tests)
 *   USE_REAL_LLM        default `true`; set `false` for a no-LLM sim
 *
 * Stop/continue a paused run (the banner prints the pid):
 *   kill -CONT -<pid>   continue the whole group
 *   Ctrl-C              stop it (this wrapper kills the group)
 */
import { spawn } from 'node:child_process';

const DEFAULT_MODEL = 'gemma4:31b-cloud';
const DEFAULT_BUDGET_MINUTES = 30;
const DEFAULT_CMD = 'npx tsx examples/visualizer-demo.ts';

const env = process.env;
const model = env['LLM_MODEL'] ?? DEFAULT_MODEL;
const cmd = env['SIM_CMD'] ?? DEFAULT_CMD;
const useRealLlm = env['USE_REAL_LLM'] ?? 'true';
const unbounded = env['SIM_UNBOUNDED'] === '1';

const rawBudget = env['SIM_BUDGET_MINUTES'];
const budgetMinutes = rawBudget === undefined ? DEFAULT_BUDGET_MINUTES : Number(rawBudget);

if (!Number.isFinite(budgetMinutes) || budgetMinutes < 0) {
  console.error(
    `[live-sim] REFUSING: SIM_BUDGET_MINUTES=${String(rawBudget)} is not a number ≥ 0.`,
  );
  process.exit(2);
}

// An unbounded real-LLM run must be a deliberate act, not a default.
if (budgetMinutes === 0 && !unbounded) {
  console.error(
    '[live-sim] REFUSING to run unbounded: set SIM_UNBOUNDED=1 to acknowledge.\n' +
      '[live-sim] (A 16 h unattended run made 47,808 cloud LLM calls and taught us nothing.)',
  );
  process.exit(2);
}

const budgetLabel = budgetMinutes === 0 ? 'UNBOUNDED (acknowledged)' : `${budgetMinutes} min`;
console.log(`[live-sim] model=${model} budget=${budgetLabel} realLlm=${useRealLlm}`);
if (model.includes(':cloud')) {
  console.log(
    '[live-sim] NOTE: a cloud model spends quota on every agent cycle; the run pauses when the budget is spent.',
  );
}

// `detached` gives the child its own process group (pgid === child.pid) so the
// whole tree can be signalled at once. `npm exec tsx` spawns grandchildren — the
// actual sim is not the direct child, so signalling only the pid would leave the
// worker running and spending.
const child = spawn(cmd, {
  shell: true,
  detached: true,
  stdio: 'inherit',
  env: { ...env, USE_REAL_LLM: useRealLlm, LLM_MODEL: model },
});

const pid = child.pid;
console.log(`[live-sim] child pid ${String(pid)}: ${cmd}`);

/** Signal the child's whole process group (negative pid). */
function signalGroup(signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone — nothing to signal.
  }
}

let paused = false;
let stopping = false;

const budgetTimer =
  budgetMinutes > 0
    ? setTimeout(() => {
        paused = true;
        signalGroup('SIGSTOP');
        console.log(
          `[sim-budget] PAUSED after ${budgetMinutes} min (budget ${budgetMinutes} min) — ` +
            `child pid ${String(pid)} is stopped and is spending nothing.`,
        );
        console.log(
          `[sim-budget] continue: kill -CONT -${String(pid)}     stop: Ctrl-C (kills it)`,
        );
      }, budgetMinutes * 60_000)
    : null;

child.on('exit', (code, signal) => {
  if (budgetTimer !== null) clearTimeout(budgetTimer);
  if (stopping) return; // our own shutdown; the cleanup path reports it
  console.log(`[live-sim] child exited (code ${String(code)} signal ${String(signal)})`);
  process.exit(code ?? 0);
});

/**
 * Shut the sim down for good. A SIGSTOPped process does not act on SIGTERM — the
 * signal stays pending until it is continued — so cleanup MUST SIGCONT first, or
 * it leaves a stopped sim behind: the exact orphan that made the 16 h run
 * possible.
 */
function shutdown(reason: string): void {
  if (stopping) return;
  stopping = true;
  if (budgetTimer !== null) clearTimeout(budgetTimer);
  console.log(
    `[live-sim] stopping child ${String(pid)} (${reason})${paused ? ' — it was paused, continuing it so it can exit' : ''}`,
  );
  if (paused) signalGroup('SIGCONT');
  signalGroup('SIGTERM');
  setTimeout(() => {
    signalGroup('SIGKILL');
    process.exit(0);
  }, 2_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
