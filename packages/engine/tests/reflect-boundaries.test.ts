/**
 * Architecture / behavioral tests for the Reflect phase engine bridge (spec 004).
 *
 * Covers:
 *  - AC-32 (package boundaries, engine side): `ReflectDataProviderImpl` (engine)
 *    must import from `@evol-hive/shared` and `@evol-hive/memory` — it must NOT
 *    import from `@evol-hive/cognition` (per ADR-0001, cognition and engine must
 *    not directly import from each other; they communicate only through `shared`).
 *  - AC-33 (no plan modification beyond clearing): The Reflect phase may only
 *    clear a completed plan. It must not create plans, advance steps, or modify
 *    plan description/steps/currentStepIndex. `ReflectDataProviderImpl` must only
 *    touch `PlanManager.isComplete` and `PlanManager.clearPlan`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentPlan, FormulatePlanResult, PlanStep } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { ReflectDataProviderImpl } from '../src/agents/reflect/index.js';
import type { PlanManager } from '../src/agents/index.js';
import type { MemoryStore, MemoryNode } from '@evol-hive/memory';
import type { MemoryEntryInput } from '@evol-hive/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_ID = 'a1';

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', 'src', rel), 'utf8');
}

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /import\s(?:[^'"]+from\s*)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specs.push(m[1]!);
  }
  return specs;
}

// ─── Fake plan manager that records every method invocation (AC-33) ─────────

class RecordingPlanManager implements PlanManager {
  calls: string[] = [];

  createPlan(_agentId: string, _result: FormulatePlanResult): AgentPlan {
    this.calls.push('createPlan');
    throw new Error('createPlan must not be called during Reflect');
  }
  advanceStep(_agentId: string): void {
    this.calls.push('advanceStep');
    throw new Error('advanceStep must not be called during Reflect');
  }
  getCurrentStep(_agentId: string): PlanStep | null {
    this.calls.push('getCurrentStep');
    return null;
  }
  isComplete(_agentId: string): boolean {
    this.calls.push('isComplete');
    return true;
  }
  clearPlan(_agentId: string): void {
    this.calls.push('clearPlan');
  }
}

// ─── Minimal fakes to construct ReflectDataProviderImpl ──────────────────────

class FakeMemoryStore implements MemoryStore {
  async store(_agentId: string, _entry: MemoryEntryInput, _ts: number): Promise<MemoryNode> {
    return {
      id: 'mem_1',
      agentId: _agentId,
      content: _entry.content,
      embedding: [],
      timestamp: _ts,
      importance: _entry.importance,
      type: _entry.type,
    };
  }
  async get(): Promise<MemoryNode | null> {
    return null;
  }
}

function setup(planManager: PlanManager = new RecordingPlanManager()) {
  const agentManager = new AgentManagerImpl();
  const driveSystem = new DriveSystemImpl(agentManager);
  const memoryStore = new FakeMemoryStore();
  const clock = () => 1000;
  const provider = new ReflectDataProviderImpl(
    agentManager,
    driveSystem,
    planManager,
    memoryStore,
    clock,
  );

  agentManager.spawn({
    id: AGENT_ID,
    name: 'Test Agent',
    description: '',
    traits: [],
    initialDrives: { energy: 50, hunger: 50 },
  });

  return { agentManager, driveSystem, planManager, memoryStore, clock, provider };
}

// ─── AC-32: engine-side package boundaries ───────────────────────────────────

describe('ReflectDataProviderImpl package boundaries — engine side (AC-32)', () => {
  it('does not import from @evol-hive/cognition', () => {
    const src = readSrc('agents/reflect/index.ts');
    const specs = importSpecifiers(src);

    // Must import from shared and memory (engine → memory is allowed per ADR-0001).
    expect(specs.some((s) => s === '@evol-hive/shared')).toBe(true);
    expect(specs.some((s) => s.startsWith('@evol-hive/memory'))).toBe(true);

    // Must NOT import from cognition.
    expect(specs.some((s) => s.startsWith('@evol-hive/cognition'))).toBe(false);
  });

  it('only imports from shared, memory, and engine-internal modules', () => {
    const src = readSrc('agents/reflect/index.ts');
    const specs = importSpecifiers(src);
    for (const s of specs) {
      const isShared = s === '@evol-hive/shared' || s.startsWith('@evol-hive/shared/');
      const isMemory = s.startsWith('@evol-hive/memory');
      const isInternal = s.startsWith('./') || s.startsWith('../');
      const isNodeBuiltin = s.startsWith('node:');
      expect(isShared || isMemory || isInternal || isNodeBuiltin).toBe(true);
    }
  });
});

// ─── AC-33: no plan modification beyond clearing ─────────────────────────────

describe('ReflectDataProviderImpl does not modify plans beyond clearing (AC-33)', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('exposes no plan-creating or plan-mutating methods (only clearPlanIfComplete)', () => {
    // The ReflectDataProvider interface (and its engine impl) must not surface
    // createPlan / advanceStep / step-mutating methods.
    expect(typeof ctx.provider.clearPlanIfComplete).toBe('function');
    expect((ctx.provider as unknown as Record<string, unknown>).createPlan).toBeUndefined();
    expect((ctx.provider as unknown as Record<string, unknown>).advanceStep).toBeUndefined();
    expect((ctx.provider as unknown as Record<string, unknown>).getCurrentStep).toBeUndefined();
  });

  it('clearPlanIfComplete only invokes PlanManager.isComplete + clearPlan (complete path)', () => {
    const recorder = new RecordingPlanManager();
    const c = setup(recorder);
    const result = c.provider.clearPlanIfComplete(AGENT_ID);

    expect(result).toBe(true);
    // isComplete is consulted, then clearPlan is invoked.
    expect(recorder.calls).toContain('isComplete');
    expect(recorder.calls).toContain('clearPlan');
    // No plan-mutating methods were called.
    expect(recorder.calls).not.toContain('createPlan');
    expect(recorder.calls).not.toContain('advanceStep');
  });

  it('clearPlanIfComplete invokes only PlanManager.isComplete (incomplete path, no clear)', () => {
    const recorder = new RecordingPlanManager();
    recorder.isComplete = () => {
      recorder.calls.push('isComplete');
      return false; // plan not complete
    };
    const c = setup(recorder);
    const result = c.provider.clearPlanIfComplete(AGENT_ID);

    expect(result).toBe(false);
    expect(recorder.calls).toContain('isComplete');
    expect(recorder.calls).not.toContain('clearPlan');
    expect(recorder.calls).not.toContain('createPlan');
    expect(recorder.calls).not.toContain('advanceStep');
  });

  it('a full reflect data flow never calls createPlan or advanceStep', async () => {
    const recorder = new RecordingPlanManager();
    const c = setup(recorder);

    // Exercise every ReflectDataProviderImpl method at least once.
    c.provider.getAgentState(AGENT_ID);
    c.provider.applyDriveChanges(AGENT_ID, { energy: 10 });
    c.provider.updateGoal(AGENT_ID, 'New goal');
    await c.provider.storeMemory(AGENT_ID, { content: 'x', importance: 5, type: 'action' });
    c.provider.setThinking(AGENT_ID, true);
    c.provider.clearPlanIfComplete(AGENT_ID);

    // The only plan-related calls allowed are isComplete and clearPlan.
    expect(recorder.calls).not.toContain('createPlan');
    expect(recorder.calls).not.toContain('advanceStep');
    expect(recorder.calls.filter((m) => m === 'isComplete' || m === 'clearPlan').length)
      .toBeGreaterThan(0);
  });
});