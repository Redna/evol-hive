/**
 * Spec 067 — A Live Run Must Leave Evidence (issue #270), leg 1
 * ─────────────────────────────────────────────────────────────
 * Test Seam 1: the sample-sink decision, asserted as **data**. `resolveSampleSink`
 * answers `file` vs `memory` from a run's configuration, so the expensive path
 * cannot quietly pick the in-memory sink while the cheap path stays cheap.
 *
 * The measured failure this guards (spec 067 Problem Summary): a real-LLM
 * visualizer run spent ~16 h and 47,808 cloud LLM calls, and no session sample
 * survived. The sink choice was made inline and silently fell back to memory.
 *
 * Red on current `main`: `resolveSampleSink` / `DEFAULT_SESSION_LOG_DIR` do not
 * exist — the decision is an inline ternary in `assembleSystem1` that cannot be
 * asserted without launching a run.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CycleOutcomeSample } from '@evol-hive/shared';
import { DEFAULT_SESSION_LOG_DIR, assembleWorld, resolveSampleSink } from '@evol-hive/assembly';

describe('spec 067 AC-9/AC-10 — a spending run always selects the file sink', () => {
  it('defaults a real-LLM run to the session-logs directory', () => {
    expect(resolveSampleSink({ useRealLlm: true })).toEqual({
      kind: 'file',
      directory: DEFAULT_SESSION_LOG_DIR,
    });
  });

  it('honours an explicit session-log directory on a real-LLM run', () => {
    expect(resolveSampleSink({ useRealLlm: true, sessionLogDir: '/tmp/evol-hive-067' })).toEqual({
      kind: 'file',
      directory: '/tmp/evol-hive-067',
    });
  });

  it('never selects the in-memory sink for a real-LLM run, for any directory input', () => {
    // AC-10 stated as an invariant: `USE_REAL_LLM=true` must not be able to
    // reach memory. Blank/whitespace is the dangerous input — a truthiness
    // check would fall back to memory here.
    for (const sessionLogDir of [undefined, '', '   ', '/tmp/x']) {
      const decision =
        sessionLogDir === undefined
          ? resolveSampleSink({ useRealLlm: true })
          : resolveSampleSink({ useRealLlm: true, sessionLogDir });
      expect(decision.kind, `useRealLlm=true, dir=${JSON.stringify(sessionLogDir)}`).toBe('file');
      expect(decision.directory).not.toBeNull();
    }
  });

  it('uses the caller-supplied default for a real-LLM run', () => {
    expect(resolveSampleSink({ useRealLlm: true, defaultDir: '/tmp/custom-default' })).toEqual({
      kind: 'file',
      directory: '/tmp/custom-default',
    });
  });
});

describe('spec 067 AC-4 — cheap deterministic runs keep the in-memory sink', () => {
  it('resolves memory when USE_REAL_LLM is false and no directory is given', () => {
    expect(resolveSampleSink({ useRealLlm: false })).toEqual({ kind: 'memory', directory: null });
  });

  it('still honours an explicit directory on a cheap run (opt-in introspection)', () => {
    expect(resolveSampleSink({ useRealLlm: false, sessionLogDir: '/tmp/explicit' })).toEqual({
      kind: 'file',
      directory: '/tmp/explicit',
    });
  });
});

describe('spec 067 — assembleSystem1 uses the decision (behavioral)', () => {
  const ENV_KEYS = ['USE_REAL_LLM', 'USE_REAL_EMBEDDINGS'] as const;
  let dir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    dir = mkdtempSync(join(tmpdir(), 'evol-hive-067-sink-'));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    rmSync(dir, { recursive: true, force: true });
  });

  const sample = (agentId: string): CycleOutcomeSample => ({
    schemaVersion: 1,
    headVersion: 1,
    agentId,
    tickNumber: 1,
    simTime: 0,
    label: 'react',
    hardTrigger: true,
    pReact: 0.5,
    outcome: {
      planChanged: true,
      drivesChanged: false,
      memoryWritten: true,
      conversationContinued: false,
    },
    scalar: null,
    embedding: null,
  });

  it("defaults a spending run's sink to session-logs without an explicit directory", () => {
    // On pre-change `main` this fails: `useRealLlm` is not an option, the sink
    // stays in memory, and no file appears — the exact silent-discard defect.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const world = assembleWorld({ system1: { useRealLlm: true } });
      world.system1?.sampleLog.record(sample('agent-default'));
      const file = join(dir, 'session-logs', 'agent-default.jsonl');
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, 'utf8').trim())).toMatchObject({
        agentId: 'agent-default',
      });
    } finally {
      process.chdir(cwd);
    }
  });

  it('keeps a cheap run in memory (no file written)', () => {
    const world = assembleWorld({ system1: {} });
    world.system1?.sampleLog.record(sample('agent-mem'));
    expect(existsSync(join(dir, 'agent-mem.jsonl'))).toBe(false);
  });
});
