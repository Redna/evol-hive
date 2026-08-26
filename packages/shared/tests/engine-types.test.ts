/**
 * Tests for the new shared engine/world types introduced in spec 005.
 * Covers AC-12 (PPERSchedulerConfig) and AC-13 (SceneDefinition).
 */
import { describe, it, expect } from 'vitest';
import { defaultPPERSchedulerConfig, defaultEngineConfig } from '../src/index.js';
import type {
  PPERSchedulerConfig,
  PPEROrchestratorPort,
  SceneDefinition,
  PPERPhase,
  EngineConfig,
} from '../src/index.js';

describe('PPERSchedulerConfig (AC-12)', () => {
  it('is defined with a maxConcurrentCycles number field', () => {
    const config: PPERSchedulerConfig = { maxConcurrentCycles: 8 };
    expect(config.maxConcurrentCycles).toBe(8);
    expect(typeof config.maxConcurrentCycles).toBe('number');
  });

  it('defaultPPERSchedulerConfig returns maxConcurrentCycles 1 (spec 022, Req 4)', () => {
    delete process.env['ENGINE_MAX_CONCURRENT_LLM'];
    const config = defaultPPERSchedulerConfig();
    expect(config.maxConcurrentCycles).toBe(1);
  });

  it('accepts a value of 1 for tight concurrency', () => {
    const config: PPERSchedulerConfig = { maxConcurrentCycles: 1 };
    expect(config.maxConcurrentCycles).toBe(1);
  });
});

describe('PPEROrchestratorPort', () => {
  it('is a structural interface with runCycle and getPhase', () => {
    const port: PPEROrchestratorPort = {
      async runCycle(_agentId: string): Promise<void> {},
      getPhase(_agentId: string): PPERPhase {
        return 'perceive';
      },
    };
    expect(typeof port.runCycle).toBe('function');
    expect(typeof port.getPhase).toBe('function');
    expect(port.getPhase('a1')).toBe('perceive');
  });
});

describe('SceneDefinition (AC-13)', () => {
  it('is defined with id, name, rooms, objects, agents', () => {
    const scene: SceneDefinition = {
      id: 'minimal',
      name: 'Minimal Scene',
      rooms: [
        {
          id: 'kitchen',
          name: 'Kitchen',
          description: 'A small kitchen',
          connections: [],
          objectIds: ['coffee-1'],
        },
      ],
      objects: [
        {
          id: 'coffee-1',
          name: 'Coffee Machine',
          type: 'appliance',
          state: { water_level: 5 },
          affordances: [],
          roomId: 'kitchen',
        },
      ],
      agents: [
        {
          id: 'agent-1',
          name: 'Test Agent',
          description: 'A test agent',
          traits: ['curious'],
          initialDrives: { energy: 20 },
        },
      ],
    };
    expect(scene.id).toBe('minimal');
    expect(scene.name).toBe('Minimal Scene');
    expect(scene.rooms).toHaveLength(1);
    expect(scene.objects).toHaveLength(1);
    expect(scene.agents).toHaveLength(1);
    expect(scene.agents[0]?.initialDrives.energy).toBe(20);
  });
});

// ─── Spec 019: Configurable Drive Decay Rate ────────────────────────────────

describe('EngineConfig.driveDecayRate (Spec 019, AC-1, AC-2)', () => {
  it('AC-1: EngineConfig accepts an optional driveDecayRate field', () => {
    const config: EngineConfig = {
      fps: 60,
      spatialDebounceSeconds: 5,
      maxConcurrentLLM: 8,
      guardrailsEnabled: true,
      guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
      driveDecayRate: 0.25,
    };
    expect(config.driveDecayRate).toBe(0.25);
  });

  it('AC-1: EngineConfig compiles without driveDecayRate (backward compatible)', () => {
    const config: EngineConfig = {
      fps: 60,
      spatialDebounceSeconds: 5,
      maxConcurrentLLM: 8,
      guardrailsEnabled: true,
      guardrails: { affordanceMasking: true, contextualForcing: true, planValidation: true },
    };
    // No driveDecayRate key — must still compile and be undefined.
    expect(config.driveDecayRate).toBeUndefined();
  });

  it('AC-2: defaultEngineConfig() returns driveDecayRate: 0.1', () => {
    const config = defaultEngineConfig();
    expect(config.driveDecayRate).toBe(0.1);
  });
});
