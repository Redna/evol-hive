/**
 * Spec 027 — Real-LLM Visualizer Demo (issue #106) — E2E test
 * ────────────────────────────────────────────────────────────────────────────
 * Macro-layer verification of AC-7 (Req 9): with `USE_REAL_LLM=true` and an
 * unreachable `LLM_BASE_URL`, the real CLI process (`tsx
 * examples/visualizer-demo.ts`) must exit non-zero with an error message that
 * includes the configured backend URL and model — and must never start the
 * visualizer server. This closes the gap between the library-level rejection
 * (unit-tested in `real-llm-visualizer.test.ts`) and the process-level
 * `main()` catch → `process.exit(1)` contract.
 *
 * Runs the actual entry point via tsx (source-level execution, same pattern as
 * the CLI tests) — no external services; the closed-port probe fails fast.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const DEMO_ENTRY = resolve(REPO_ROOT, 'examples/visualizer-demo.ts');

/** Run the visualizer demo CLI as a child process. */
function runDemo(env: Record<string, string>): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync('npx', ['tsx', DEMO_ENTRY], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      // Minimal env — no LLM/embedding vars unless explicitly provided.
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      ...env,
    },
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('spec 027 AC-7 (E2E): demo process exits non-zero on unreachable LLM backend', () => {
  it('USE_REAL_LLM=true + unreachable LLM_BASE_URL → exit 1, stderr names URL and model, server never started', () => {
    const result = runDemo({
      USE_REAL_LLM: 'true',
      LLM_BASE_URL: 'http://127.0.0.1:9/v1',
      LLM_MODEL: 'e2e-unreachable-model',
    });

    // Non-zero exit (the loud-failure contract).
    expect(result.exitCode).toBe(1);

    // Error output names the backend URL and the configured model.
    expect(result.stderr).toContain('http://127.0.0.1:9/v1');
    expect(result.stderr).toContain('e2e-unreachable-model');

    // The visualizer server must never have started (health check runs first).
    expect(result.stdout).not.toContain('running at');
  }, 60_000);
});
