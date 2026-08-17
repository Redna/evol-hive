/**
 * Tests for JSON_INSTRUCTION_SUFFIX constant and builder prompt suffixes
 * (spec 009, issue #34).
 *
 * Covers AC-15, AC-16, AC-17, AC-18, AC-34, AC-35.
 */
import { describe, it, expect } from 'vitest';
import { JSON_INSTRUCTION_SUFFIX } from '@evol-hive/shared';
import type { AgentInternalState, ExecuteResult, PerceptionResult } from '@evol-hive/shared';
import { PlanBuilderImpl, ReflectBuilderImpl, PerceptionBuilderImpl } from '../src/index.js';

const FULL_DRIVES = { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 };

// ─── AC-15: JSON_INSTRUCTION_SUFFIX constant ─────────────────────────────────

describe('JSON_INSTRUCTION_SUFFIX constant (AC-15)', () => {
  it('is exported from @evol-hive/shared', () => {
    expect(JSON_INSTRUCTION_SUFFIX).toBeDefined();
    expect(typeof JSON_INSTRUCTION_SUFFIX).toBe('string');
  });

  it('has the exact value specified in the spec (AC-15)', () => {
    const expected =
      'IMPORTANT: Respond ONLY with a valid JSON object. Do not include any prose, markdown formatting, code fences, or XML tags. The JSON must match the provided schema exactly.';
    expect(JSON_INSTRUCTION_SUFFIX).toBe(expected);
  });
});

// ─── AC-16, AC-34: PlanBuilderImpl suffix ────────────────────────────────────

describe('PlanBuilderImpl JSON instruction suffix (AC-16, AC-34)', () => {
  const makePerceptionResult = (): PerceptionResult => {
    return {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
        drives: FULL_DRIVES,
      },
      prunedAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }],
      primaryDriveLabel: 'energy',
    };
  };

  it('systemPrompt ends with JSON_INSTRUCTION_SUFFIX (AC-16, AC-34)', () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt.endsWith(JSON_INSTRUCTION_SUFFIX)).toBe(true);
  });

  it('systemPrompt contains the JSON instruction content (AC-16)', () => {
    const builder = new PlanBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt).toContain('Respond ONLY with a valid JSON object');
    expect(payload.systemPrompt).toContain('Do not include any prose');
  });
});

// ─── AC-17: PerceptionBuilder suffix ─────────────────────────────────────────

describe('PerceptionBuilder JSON instruction suffix (AC-17)', () => {
  const makePerceptionResult = (): PerceptionResult => {
    return {
      passive: {
        roomId: 'kitchen',
        objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
        drives: FULL_DRIVES,
      },
      prunedAffordances: [{ id: 'brew_coffee', label: 'Brew coffee' }],
      primaryDriveLabel: 'energy',
    };
  };

  it('systemPrompt ends with JSON_INSTRUCTION_SUFFIX (AC-17)', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt.endsWith(JSON_INSTRUCTION_SUFFIX)).toBe(true);
  });

  it('systemPrompt contains the JSON instruction content (AC-17)', () => {
    const builder = new PerceptionBuilderImpl();
    const payload = builder.build(makePerceptionResult());
    expect(payload.systemPrompt).toContain('Respond ONLY with a valid JSON object');
  });
});

// ─── AC-18, AC-35: ReflectBuilderImpl suffix ────────────────────────────────

describe('ReflectBuilderImpl JSON instruction suffix (AC-18, AC-35)', () => {
  const makeAgentState = (): AgentInternalState => {
    return {
      agentId: 'agent-1',
      drives: FULL_DRIVES,
      currentGoal: 'Stay alive',
      currentPlan: null,
      isThinking: false,
      location: 'kitchen',
      lastPerceptionTick: 0,
    };
  };

  const makeExecuteResult = (): ExecuteResult => {
    return {
      success: true,
      planComplete: false,
    };
  };

  it('systemPrompt ends with JSON_INSTRUCTION_SUFFIX (AC-18, AC-35)', () => {
    const builder = new ReflectBuilderImpl();
    const payload = builder.build('agent-1', makeAgentState(), makeExecuteResult());
    expect(payload.systemPrompt.endsWith(JSON_INSTRUCTION_SUFFIX)).toBe(true);
  });

  it('systemPrompt contains the JSON instruction content (AC-18)', () => {
    const builder = new ReflectBuilderImpl();
    const payload = builder.build('agent-1', makeAgentState(), makeExecuteResult());
    expect(payload.systemPrompt).toContain('Respond ONLY with a valid JSON object');
    expect(payload.systemPrompt).toContain('Do not include any prose');
  });
});
