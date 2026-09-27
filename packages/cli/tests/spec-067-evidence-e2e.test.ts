/**
 * Spec 067 — A Live Run Must Leave Evidence (issue #270), leg 1
 * ─────────────────────────────────────────────────────────────
 * Integration across the `scripts` ↔ `assembly` boundary. The launcher
 * announces an evidence directory and passes it to the child (covered by
 * `spec-067-live-sim-evidence.test.ts`); this suite closes the loop: a child
 * that honours the announced directory and assembles a spending world MUST
 * actually leave parseable JSONL there.
 *
 * The child is a stub `.mjs` fixture importing the built `@evol-hive/assembly`
 * package and recording one sample — no LLM and no network. This is the
 * end-to-end seam for AC-9 (a spending run reaches a file sink) and AC-11
 * (samples parse as JSONL with the existing schema fields).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/live-sim.mts');
const ASSEMBLY_DIST = join(REPO_ROOT, 'packages/assembly/dist/index.js');

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Drop ambient sim/LLM/evidence env so each test owns its configuration. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(SIM_|LLM_MODEL|USE_REAL_LLM|SYSTEM1_)/.test(key)) delete env[key];
  }
  return env;
}

/** Run the launcher once (with the stub fixture as SIM_CMD) and wait for exit. */
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

const fixtures: string[] = [];
const tempDirs: string[] = [];

/**
 * A child fixture that mimics how the demo consumes the launcher's evidence
 * config: read `SYSTEM1_SESSION_LOG_DIR`, assemble a spending world with it,
 * record one sample, and echo the directory it used.
 */
function writeFixture(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'evol-hive-067-fixture-')), 'child.mjs');
  writeFileSync(
    path,
    `const { assembleWorld } = await import(${JSON.stringify(ASSEMBLY_DIST)});
const dir = process.env.SYSTEM1_SESSION_LOG_DIR;
console.log('CHILD_EVIDENCE=[' + (dir ?? '') + ']');
if (!dir) {
  console.error('CHILD: no evidence directory configured');
  process.exit(3);
}
const world = assembleWorld({ system1: { useRealLlm: true, sessionLogDir: dir } });
world.system1.sampleLog.record({
  schemaVersion: 1,
  headVersion: 1,
  agentId: 'e2e-agent',
  tickNumber: 12,
  simTime: 3,
  label: 'react',
  hardTrigger: true,
  pReact: 0.8,
  outcome: {
    planChanged: true,
    drivesChanged: false,
    memoryWritten: true,
    conversationContinued: false,
  },
  scalar: null,
  embedding: null,
});
`,
    'utf8',
  );
  fixtures.push(path);
  return path;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(join(fixture, '..'), { recursive: true, force: true });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('spec 067 — the launcher announces a sink a spending child can actually use', () => {
  it('writes JSONL samples to the announced directory, parseable with the sample schema', async () => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'evol-hive-067-evidence-'));
    tempDirs.push(evidenceDir);
    const fixture = writeFixture();

    const result = await runLauncher({
      SIM_CMD: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`,
      SYSTEM1_SESSION_LOG_DIR: evidenceDir,
    });

    expect(result.code, `launcher stderr: ${result.stderr}`).toBe(0);
    // The banner names the sink, and the child saw the same directory.
    expect(result.stdout).toContain(`evidence=${evidenceDir}`);
    expect(result.stdout).toContain(`CHILD_EVIDENCE=[${evidenceDir}]`);

    // AC-9: a spending run produced a file rather than discarding samples.
    const sampleFile = join(evidenceDir, 'e2e-agent.jsonl');
    expect(existsSync(sampleFile)).toBe(true);

    // AC-11: the line parses with the existing sample schema.
    const lines = readFileSync(sampleFile, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines.length).toBe(1);
    const sample = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(sample).toMatchObject({
      schemaVersion: 1,
      agentId: 'e2e-agent',
      tickNumber: 12,
      simTime: 3,
      label: 'react',
      hardTrigger: true,
      pReact: 0.8,
      outcome: {
        planChanged: true,
        drivesChanged: false,
        memoryWritten: true,
        conversationContinued: false,
      },
    });
    expect(sample).toHaveProperty('scalar');
    expect(sample).toHaveProperty('embedding');
  }, 30_000);

  it('writes nothing when the launcher refuses a blank evidence directory', async () => {
    const fixture = writeFixture();
    const result = await runLauncher({
      SIM_CMD: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`,
      SYSTEM1_SESSION_LOG_DIR: '   ',
    });

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/REFUSING/);
    expect(result.stdout).not.toContain('CHILD_EVIDENCE');
  }, 30_000);
});
