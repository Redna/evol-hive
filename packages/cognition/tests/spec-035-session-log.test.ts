/**
 * Spec 035 — Session sample logging tests (Req 9 / AC-4 format portion).
 * Feature vector + label + schema version + head version are appended to a
 * per-agent JSONL session log. The label decision itself is covered by the
 * engine tests; here we pin the JSONL line format and writer plumbing.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEATURE_SCHEMA_VERSION,
  SCALAR_FEATURE_FIELDS,
  type CycleOutcomeSample,
} from '@evol-hive/shared';
import {
  JsonlSessionSampleLog,
  InMemorySampleLogWriter,
  makeFileSampleLogWriter,
} from '../src/system1/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function reactSample(overrides: Partial<CycleOutcomeSample> = {}): CycleOutcomeSample {
  const scalar = {} as CycleOutcomeSample['scalar'];
  SCALAR_FEATURE_FIELDS.forEach((f, i) => {
    scalar[f] = i / SCALAR_FEATURE_FIELDS.length;
  });
  return {
    schemaVersion: FEATURE_SCHEMA_VERSION,
    headVersion: 7,
    agentId: 'a1',
    tickNumber: 42,
    simTime: 0.7,
    label: 'react',
    hardTrigger: false,
    pReact: 0.73,
    scalar,
    embedding: [0.1, 0.2],
    outcome: {
      planChanged: true,
      drivesChanged: false,
      memoryWritten: false,
      conversationContinued: false,
    },
    ...overrides,
  };
}

describe('Spec 035 — JSONL session log (Req 9 / AC-4)', () => {
  it('appends one JSON object per line with schema + head versions stamped', () => {
    const writer = new InMemorySampleLogWriter();
    const log = new JsonlSessionSampleLog(writer);
    log.record(reactSample());
    log.record(
      reactSample({
        label: 'ignore',
        tickNumber: 43,
        outcome: {
          planChanged: false,
          drivesChanged: false,
          memoryWritten: false,
          conversationContinued: false,
        },
      }),
    );

    const lines = writer.toString().trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first['schemaVersion']).toBe(FEATURE_SCHEMA_VERSION);
    expect(first['headVersion']).toBe(7);
    expect(first['label']).toBe('react');
    expect(first['agentId']).toBe('a1');
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(second['label']).toBe('ignore');
  });

  it('writes fixed top-level key order (contract for the trainer)', () => {
    const writer = new InMemorySampleLogWriter();
    const log = new JsonlSessionSampleLog(writer);
    log.record(reactSample());
    const line = writer.toString().trim();
    const keys = Object.keys(JSON.parse(line));
    expect(keys).toEqual([
      'schemaVersion',
      'headVersion',
      'agentId',
      'tickNumber',
      'simTime',
      'label',
      'hardTrigger',
      'pReact',
      'outcome',
      'scalar',
      'embedding',
    ]);
    // Scalar keys are also in the documented fixed order.
    const scalarKeys = Object.keys(
      (JSON.parse(line) as { scalar: Record<string, unknown> }).scalar,
    );
    expect(scalarKeys).toEqual([...SCALAR_FEATURE_FIELDS]);
  });

  it('records the full feature vector: embedding present in the line', () => {
    const writer = new InMemorySampleLogWriter();
    const log = new JsonlSessionSampleLog(writer);
    log.record(reactSample({ embedding: [0.5, -0.5, 1] }));
    const parsed = JSON.parse(writer.toString().trim()) as { embedding: number[] };
    expect(parsed.embedding).toEqual([0.5, -0.5, 1]);
  });

  it('the file writer appends per-agent JSONL to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evol-hive-s1log-'));
    try {
      const writer = makeFileSampleLogWriter(dir);
      const log = new JsonlSessionSampleLog(writer);
      log.record(reactSample());
      log.record(reactSample({ agentId: 'a2' }));
      const a1 = readFileSync(join(dir, 'a1.jsonl'), 'utf8').trim().split('\n');
      const a2 = readFileSync(join(dir, 'a2.jsonl'), 'utf8').trim().split('\n');
      expect(a1).toHaveLength(1);
      expect(a2).toHaveLength(1);
      expect((JSON.parse(a1[0]!) as { agentId: string }).agentId).toBe('a1');
      // Appending twice goes to the same file (append, not truncate).
      log.record(reactSample());
      expect(readFileSync(join(dir, 'a1.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
