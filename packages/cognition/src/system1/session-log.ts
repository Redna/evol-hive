/**
 * system1/session-log — Per-agent JSONL session sample log (spec 035, Req 9)
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature vector + label + schema version + head version are appended to a
 * per-agent JSONL session log (`<dir>/<agentId>.jsonl`), extendable to the
 * existing persistence/session plumbing. The JSON key order is the
 * serialization contract consumed by `training/train_react_gate.py`.
 *
 * The writer is injectable (in-memory for tests, file-backed for runtime) so
 * no test touches the filesystem unless it explicitly wants to.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CycleOutcomeSample, System1SampleSinkPort } from '@evol-hive/shared';

/** Injectable line sink: receives one serialized sample per call. */
export interface SampleLogWriter {
  appendLine(agentId: string, line: string): void;
}

/** In-memory writer (tests / introspection). */
export class InMemorySampleLogWriter implements SampleLogWriter {
  private readonly lines = new Map<string, string[]>();

  appendLine(agentId: string, line: string): void {
    const existing = this.lines.get(agentId);
    if (existing) {
      existing.push(line);
    } else {
      this.lines.set(agentId, [line]);
    }
  }

  /** All lines for an agent joined with newlines. */
  toString(agentId?: string): string {
    if (agentId !== undefined) {
      return (this.lines.get(agentId) ?? []).join('\n');
    }
    const all: string[] = [];
    for (const lines of this.lines.values()) {
      all.push(...lines);
    }
    return all.join('\n');
  }

  /** Raw lines per agent (test helper). */
  linesFor(agentId: string): string[] {
    return [...(this.lines.get(agentId) ?? [])];
  }
}

/**
 * File-backed writer: appends `<dir>/<agentId>.jsonl` synchronously (the
 * runtime is Node-only — see `onnxruntime-node`; one small line per completed
 * cycle is negligible). Write failures are logged and swallowed — a broken
 * session log must never break the game loop.
 */
export function makeFileSampleLogWriter(dir: string): SampleLogWriter {
  const dirsCreated = new Set<string>();
  return {
    appendLine(agentId: string, line: string): void {
      try {
        if (!dirsCreated.has(dir)) {
          mkdirSync(dir, { recursive: true });
          dirsCreated.add(dir);
        }
        appendFileSync(join(dir, `${agentId}.jsonl`), line + '\n', 'utf8');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[JsonlSessionSampleLog] failed to append sample: ${message}`);
      }
    },
  };
}

/**
 * Serializes a sample with the fixed key order (the trainer's contract):
 * schemaVersion, headVersion, agentId, tickNumber, simTime, label,
 * hardTrigger, pReact, outcome, scalar, embedding — and the scalar keys in
 * the documented {@link SCALAR_FEATURE_FIELDS} order.
 */
export function serializeSample(sample: CycleOutcomeSample): string {
  const ordered: Record<string, unknown> = {
    schemaVersion: sample.schemaVersion,
    headVersion: sample.headVersion,
    agentId: sample.agentId,
    tickNumber: sample.tickNumber,
    simTime: sample.simTime,
    label: sample.label,
    hardTrigger: sample.hardTrigger,
    pReact: sample.pReact,
    ...(sample.outcome !== undefined ? { outcome: sample.outcome } : {}),
    scalar: sample.scalar,
    embedding: sample.embedding,
  };
  return JSON.stringify(ordered);
}

/**
 * The JSONL session sample log (Req 9): one line per completed cycle, keyed
 * per agent. Implements the shared {@link System1SampleSinkPort} so the
 * engine's outcome recorder can append without importing this module
 * directly (assembly wires it).
 */
export class JsonlSessionSampleLog implements System1SampleSinkPort {
  private readonly writer: SampleLogWriter;

  constructor(writer: SampleLogWriter) {
    this.writer = writer;
  }

  /** Append one labeled sample (one JSONL line). */
  record(sample: CycleOutcomeSample): void {
    this.writer.appendLine(sample.agentId, serializeSample(sample));
  }

  /** The shared sink port — delegates to {@link record}. */
  append = (sample: CycleOutcomeSample): void => {
    this.record(sample);
  };
}
