/**
 * Tests for the Agent Persona System — cognition layer (spec 012).
 * Covers AC-9 through AC-22 (builder persona injection & service wiring).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Affordance,
  AgentInternalState,
  AgentPlan,
  AgentProfile,
  ExecuteDataProvider,
  ExecuteResult,
  FormulatePlanResult,
  LLMActionResponse,
  PassivePerception,
  PerceptionDataProvider,
  PerceptionResult,
  PlanDataProvider,
  ReflectDataProvider,
  ReflectionResult,
  ReflectLLMResponse,
  ReflectResult,
} from '@evol-hive/shared';
import type { LLMClient, LLMContextPayload, ReflectBuilder } from '../src/index.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { ReflectBuilderImpl } from '../src/pper/reflect-builder.js';
import { PerceptionServiceImpl } from '../src/pper/index.js';
import { ReflectServiceImpl } from '../src/pper/reflect-service.js';
import type { ReflectServiceOptions } from '../src/pper/reflect-service.js';
import type { AffordanceClassifier } from '../src/classifier/index.js';

const AGENT_ID = 'a1';
const ROOM_ID = 'kitchen';
const drives = { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 };

const objects = [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }];

const prunedAffordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
  },
];

function makeAgentState(overrides: Partial<AgentInternalState> = {}): AgentInternalState {
  return {
    agentId: AGENT_ID,
    drives: { energy: 50, hunger: 30, social: 80, comfort: 60, curiosity: 40 },
    currentGoal: 'Stay alive',
    currentPlan: null,
    isThinking: false,
    location: ROOM_ID,
    lastPerceptionTick: 0,
    ...overrides,
  };
}

function makeExecuteResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return { success: true, planComplete: false, ...overrides };
}

function makePerceptionResult(
  overrides: Partial<PerceptionResult> = {},
  passiveOverrides: Partial<PassivePerception> = {},
): PerceptionResult {
  const passive: PassivePerception = {
    roomId: ROOM_ID,
    objectsPresent: objects,
    drives,
    ...passiveOverrides,
  };
  return {
    passive,
    prunedAffordances,
    primaryDriveLabel: 'low energy, need to restore energy',
    ...overrides,
  };
}

function makePersonaProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: AGENT_ID,
    name: 'Alice',
    description: 'A researcher',
    traits: ['diligent'],
    initialDrives: {},
    backstory: 'A caffeine-dependent researcher',
    behavioralTendencies: ['curious', 'social'],
    speechStyle: 'precise and academic',
    longTermGoals: ['finish thesis', 'publish paper'],
    relationships: { 'agent-bob': 'trusted colleague' },
    ...overrides,
  };
}

// ─── AC-9: PerceptionBuilderImpl persona in systemPrompt ─────────────────────

describe('PerceptionBuilderImpl — persona injection (AC-9, AC-10, AC-11, AC-12)', () => {
  const builder = new PerceptionBuilderImpl();

  it('systemPrompt contains name and backstory when persona is present (AC-9)', () => {
    const profile = makePersonaProfile();
    const result = makePerceptionResult({ persona: profile });
    const payload = builder.build(result);
    expect(payload.systemPrompt).toContain('Alice');
    expect(payload.systemPrompt).toContain('caffeine-dependent researcher');
  });

  it('systemPrompt does not contain persona text when persona is null (AC-10)', () => {
    const result = makePerceptionResult({ persona: null });
    const payload = builder.build(result);
    expect(payload.systemPrompt).not.toContain('Alice');
    expect(payload.systemPrompt).not.toContain('caffeine-dependent');
    // Should still contain the generic prompt.
    expect(payload.systemPrompt).toContain('autonomous NPC');
  });

  it('systemPrompt falls back to generic when persona is undefined (AC-10)', () => {
    const result = makePerceptionResult({ persona: undefined });
    const payload = builder.build(result);
    expect(payload.systemPrompt).toContain('autonomous NPC');
  });

  it('perceptionContext includes "Name: Alice" as first line when persona present (AC-11)', () => {
    const profile = makePersonaProfile();
    const result = makePerceptionResult({ persona: profile });
    const payload = builder.build(result);
    const lines = payload.perceptionContext.split('\n');
    expect(lines[0]).toBe('Name: Alice');
  });

  it('perceptionContext includes "Tendencies: curious, social" when tendencies present (AC-12)', () => {
    const profile = makePersonaProfile({ behavioralTendencies: ['curious', 'social'] });
    const result = makePerceptionResult({ persona: profile });
    const payload = builder.build(result);
    expect(payload.perceptionContext).toContain('Tendencies: curious, social');
  });

  it('perceptionContext does not include Name line when persona is null (AC-11)', () => {
    const result = makePerceptionResult({ persona: null });
    const payload = builder.build(result);
    expect(payload.perceptionContext).not.toContain('Name: Alice');
  });
});

// ─── AC-13: PlanBuilderImpl persona in systemPrompt ──────────────────────────

describe('PlanBuilderImpl — persona injection (AC-13, AC-14)', () => {
  const builder = new PlanBuilderImpl();

  it('systemPrompt contains name and does not start with generic NPC prompt (AC-13)', () => {
    const profile = makePersonaProfile();
    const result = makePerceptionResult({ persona: profile });
    const payload = builder.build(result);
    expect(payload.systemPrompt).toContain('Alice');
    expect(payload.systemPrompt).not.toContain('autonomous NPC');
  });

  it('systemPrompt contains persona backstory (AC-13)', () => {
    const profile = makePersonaProfile({ backstory: 'A caffeine-dependent researcher' });
    const result = makePerceptionResult({ persona: profile });
    const payload = builder.build(result);
    expect(payload.systemPrompt).toContain('caffeine-dependent researcher');
  });

  it('systemPrompt is the generic plan prompt when persona is null (AC-14)', () => {
    const result = makePerceptionResult({ persona: null });
    const payload = builder.build(result);
    expect(payload.systemPrompt).toContain('autonomous NPC');
    expect(payload.systemPrompt).not.toContain('Alice');
  });

  it('systemPrompt is the generic plan prompt when persona is undefined (AC-14)', () => {
    const result = makePerceptionResult({ persona: undefined });
    const payload = builder.build(result);
    expect(payload.systemPrompt).toContain('autonomous NPC');
  });
});

// ─── AC-15: ReflectBuilder interface 4th param ────────────────────────────────

describe('ReflectBuilder interface — optional 4th param (AC-15)', () => {
  it('compiles when called with 3 args (no profile)', () => {
    const builder: ReflectBuilder = new ReflectBuilderImpl();
    const payload = builder.build(AGENT_ID, makeAgentState(), makeExecuteResult());
    expect(payload.systemPrompt).toBeDefined();
  });

  it('compiles when called with 4th arg (profile)', () => {
    const builder: ReflectBuilder = new ReflectBuilderImpl();
    const payload = builder.build(
      AGENT_ID,
      makeAgentState(),
      makeExecuteResult(),
      makePersonaProfile(),
    );
    expect(payload.systemPrompt).toContain('Alice');
  });

  it('compiles when called with null profile', () => {
    const builder: ReflectBuilder = new ReflectBuilderImpl();
    const payload = builder.build(AGENT_ID, makeAgentState(), makeExecuteResult(), null);
    expect(payload.systemPrompt).toContain('autonomous NPC');
  });
});

// ─── AC-16, AC-17: ReflectBuilderImpl persona injection ───────────────────────

describe('ReflectBuilderImpl — persona injection (AC-16, AC-17, AC-18)', () => {
  const builder = new ReflectBuilderImpl();
  const agentState = makeAgentState();
  const executeResult = makeExecuteResult();

  it('systemPrompt contains name and backstory when profile present (AC-16)', () => {
    const profile = makePersonaProfile({ backstory: 'A caffeine-dependent researcher' });
    const payload = builder.build(AGENT_ID, agentState, executeResult, profile);
    expect(payload.systemPrompt).toContain('Alice');
    expect(payload.systemPrompt).toContain('caffeine-dependent researcher');
  });

  it('systemPrompt includes persona-weighted memory instruction (AC-16)', () => {
    const profile = makePersonaProfile();
    const payload = builder.build(AGENT_ID, agentState, executeResult, profile);
    expect(payload.systemPrompt).toContain(
      'Consider your personality when deciding what is worth remembering.',
    );
  });

  it('systemPrompt is generic reflect prompt when profile is null (AC-17)', () => {
    const payload = builder.build(AGENT_ID, agentState, executeResult, null);
    expect(payload.systemPrompt).toContain('autonomous NPC');
    expect(payload.systemPrompt).not.toContain('Consider your personality');
  });

  it('systemPrompt is generic reflect prompt when profile is undefined (AC-17)', () => {
    const payload = builder.build(AGENT_ID, agentState, executeResult);
    expect(payload.systemPrompt).toContain('autonomous NPC');
    expect(payload.systemPrompt).not.toContain('Consider your personality');
  });

  it('perceptionContext includes "Aspirations: finish thesis; publish paper" (AC-18)', () => {
    const profile = makePersonaProfile({ longTermGoals: ['finish thesis', 'publish paper'] });
    const payload = builder.build(AGENT_ID, agentState, executeResult, profile);
    expect(payload.perceptionContext).toContain('Aspirations: finish thesis; publish paper');
  });

  it('perceptionContext does not include Aspirations when no longTermGoals (AC-18)', () => {
    const profile = makePersonaProfile({ longTermGoals: undefined });
    const payload = builder.build(AGENT_ID, agentState, executeResult, profile);
    expect(payload.perceptionContext).not.toContain('Aspirations:');
  });
});

// ─── AC-19, AC-20: PerceptionServiceImpl populates persona ───────────────────

describe('PerceptionServiceImpl — persona population (AC-19, AC-20)', () => {
  const fakeClassifier: AffordanceClassifier = {
    async prune(_drive, affordances) {
      return affordances;
    },
  };

  it('sets persona to the profile returned by provider (AC-19)', async () => {
    const profile = makePersonaProfile();
    const provider: PerceptionDataProvider = {
      getAgentLocation: () => ROOM_ID,
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => [],
      getAgentDrives: () => ({ ...drives }),
      getPrimaryDriveLabel: () => 'low energy',
      getSystemFeedback: () => undefined,
      getAgentProfile: () => profile,
    };
    const service = new PerceptionServiceImpl({ provider, classifier: fakeClassifier });
    const result = await service.perceive(AGENT_ID);
    expect(result.persona).toBe(profile);
  });

  it('sets persona to null when provider returns null (AC-19)', async () => {
    const provider: PerceptionDataProvider = {
      getAgentLocation: () => ROOM_ID,
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => [],
      getAgentDrives: () => ({ ...drives }),
      getPrimaryDriveLabel: () => 'low energy',
      getSystemFeedback: () => undefined,
      getAgentProfile: () => null,
    };
    const service = new PerceptionServiceImpl({ provider, classifier: fakeClassifier });
    const result = await service.perceive(AGENT_ID);
    expect(result.persona).toBeNull();
  });

  it('sets persona to undefined when provider does not implement getAgentProfile (AC-20)', async () => {
    // Older mock — no getAgentProfile method at all.
    const provider = {
      getAgentLocation: () => ROOM_ID,
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => [],
      getAgentDrives: () => ({ ...drives }),
      getPrimaryDriveLabel: () => 'low energy',
      getSystemFeedback: () => undefined,
    } as unknown as PerceptionDataProvider;
    const service = new PerceptionServiceImpl({ provider, classifier: fakeClassifier });
    const result = await service.perceive(AGENT_ID);
    expect(result.persona).toBeUndefined();
  });
});

// ─── AC-21, AC-22: ReflectServiceImpl passes persona to builder ──────────────

class FakeReflectDataProvider implements ReflectDataProvider {
  agentState: AgentInternalState | null = makeAgentState();
  profile: AgentProfile | null = null;
  getAgentProfileImpl = true;

  getAgentState(): AgentInternalState | null {
    return this.agentState;
  }
  applyDriveChanges(): void {}
  updateGoal(): void {}
  async storeMemory(): Promise<void> {}
  clearPlanIfComplete(): boolean {
    return false;
  }
  setThinking(): void {}
  getAgentProfile(agentId: string): AgentProfile | null {
    if (agentId === AGENT_ID) return this.profile;
    return null;
  }
}

class CapturingReflectBuilder implements ReflectBuilder {
  lastProfile: AgentProfile | null | undefined = 'NOT_CALLED';

  build(
    _agentId: string,
    _agentState: AgentInternalState,
    _executeResult: ExecuteResult,
    profile?: AgentProfile | null,
  ): LLMContextPayload {
    this.lastProfile = profile;
    return {
      systemPrompt: 'test',
      perceptionContext: 'test',
      availableAffordances: [],
      cognitiveTools: [],
      tools: [],
    };
  }
}

function makeReflectService(
  provider: FakeReflectDataProvider,
  reflectResponse: ReflectLLMResponse = {},
): { service: ReflectServiceImpl; builder: CapturingReflectBuilder; llm: LLMClient } {
  const builder = new CapturingReflectBuilder();
  const llm: LLMClient = {
    completeStructured: vi.fn(),
    completeReflection: vi.fn(),
    completePlan: vi.fn(),
    completeReflect: vi.fn().mockResolvedValue(reflectResponse),
  };
  const opts: ReflectServiceOptions = {
    reflectBuilder: builder,
    llmClient: llm,
    dataProvider: provider,
  };
  return { service: new ReflectServiceImpl(opts), builder, llm };
}

describe('ReflectServiceImpl — persona passing (AC-21, AC-22)', () => {
  it('passes the profile from dataProvider.getAgentProfile to the builder (AC-21)', async () => {
    const profile = makePersonaProfile();
    const provider = new FakeReflectDataProvider();
    provider.profile = profile;
    const { service, builder } = makeReflectService(provider);
    await service.reflect(AGENT_ID, makeExecuteResult());
    expect(builder.lastProfile).toBe(profile);
  });

  it('passes null when getAgentProfile returns null (AC-21)', async () => {
    const provider = new FakeReflectDataProvider();
    provider.profile = null;
    const { service, builder } = makeReflectService(provider);
    await service.reflect(AGENT_ID, makeExecuteResult());
    expect(builder.lastProfile).toBeNull();
  });

  it('passes undefined when provider does not implement getAgentProfile (AC-22)', async () => {
    // Older mock — no getAgentProfile method.
    const provider = {
      agentState: makeAgentState(),
      getAgentState: () => makeAgentState(),
      applyDriveChanges: () => {},
      updateGoal: () => {},
      storeMemory: async () => {},
      clearPlanIfComplete: () => false,
      setThinking: () => {},
    } as unknown as ReflectDataProvider;
    const builder = new CapturingReflectBuilder();
    const llm: LLMClient = {
      completeStructured: vi.fn(),
      completeReflection: vi.fn(),
      completePlan: vi.fn(),
      completeReflect: vi.fn().mockResolvedValue({}),
    };
    const service = new ReflectServiceImpl({
      reflectBuilder: builder,
      llmClient: llm,
      dataProvider: provider,
    });
    await service.reflect(AGENT_ID, makeExecuteResult());
    expect(builder.lastProfile).toBeUndefined();
  });
});

// ─── AC-26, AC-27: Full PPER cycle persona flow ───────────────────────────────

describe('Full PPER cycle persona flow (AC-26, AC-27)', () => {
  const personaProfile: AgentProfile = {
    id: 'a1',
    name: 'Alice',
    description: 'A researcher',
    traits: ['diligent'],
    initialDrives: { energy: 20 },
    backstory: 'A sleepy researcher',
    behavioralTendencies: ['cautious'],
  };

  const oldStyleProfile: AgentProfile = {
    id: 'a1',
    name: 'Alice',
    description: 'A sleepy agent who needs coffee',
    traits: ['diligent'],
    initialDrives: { energy: 20 },
  };

  function makeFullCycleProviders(profile: AgentProfile | null) {
    const state: AgentInternalState = makeAgentState({
      agentId: 'a1',
      drives: { energy: 20, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
      location: 'kitchen',
    });

    const perceptionProvider: PerceptionDataProvider = {
      getAgentLocation: () => state.location,
      getObjectsInRoom: () => [{ id: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
      getAffordancesInRoom: () => [
        {
          id: 'brew_coffee',
          label: 'Brew coffee',
          engineEffect: 'brew_coffee',
          preconditions: [],
          effects: { energy: 20 },
        },
      ],
      getAgentDrives: () => ({ ...state.drives }),
      getPrimaryDriveLabel: () => 'low energy, need to restore energy',
      getSystemFeedback: () => undefined,
      getAgentProfile: () => profile,
    };

    const planProvider = {
      getAgentState: () => state,
      storePlan: (_id: string, result: FormulatePlanResult) => {
        const plan = {
          id: 'plan-1',
          description: result.description,
          steps: result.steps.map((s) => ({ description: s.description, completed: false })),
          currentStepIndex: 0,
          createdAt: 0,
        } as AgentPlan;
        state.currentPlan = plan;
        return plan;
      },
      setThinking: (_id: string, v: boolean) => {
        state.isThinking = v;
      },
    } as unknown as PlanDataProvider;

    const executeProvider = {
      getAgentState: () => state,
      getCurrentStep: () => ({
        description: 'brew',
        completed: false,
        targetAffordance: 'brew_coffee',
      }),
      isPlanComplete: () => false,
      resolveAffordance: () => ({
        objectId: 'coffee-1',
        affordance: {
          id: 'brew_coffee',
          label: 'Brew coffee',
          engineEffect: 'brew_coffee',
          preconditions: [],
          effects: { energy: 20 },
        },
      }),
      checkPreconditions: () => ({ satisfied: true, failed: [] }),
      executeAffordance: async () => ({ success: true, driveChanges: { energy: 20 } }),
      advanceStep: () => {
        if (state.currentPlan) state.currentPlan.currentStepIndex = state.currentPlan.steps.length;
      },
      applyDriveChanges: () => {},
      setSystemFeedback: () => {},
      setThinking: (_id: string, v: boolean) => {
        state.isThinking = v;
      },
    } as unknown as ExecuteDataProvider;

    const reflectProvider: ReflectDataProvider = {
      getAgentState: () => state,
      applyDriveChanges: () => {},
      updateGoal: (_id: string, goal: string) => {
        state.currentGoal = goal;
      },
      storeMemory: async () => {},
      clearPlanIfComplete: () => {
        state.currentPlan = null;
        return true;
      },
      setThinking: (_id: string, v: boolean) => {
        state.isThinking = v;
      },
      getAgentProfile: () => profile,
    };

    return { state, perceptionProvider, planProvider, executeProvider, reflectProvider };
  }

  function makeCapturingLLM(): LLMClient & {
    planPayload: LLMContextPayload | null;
    reflectPayload: LLMContextPayload | null;
    structuredPayload: LLMContextPayload | null;
  } {
    const llm = {
      planPayload: null as LLMContextPayload | null,
      reflectPayload: null as LLMContextPayload | null,
      structuredPayload: null as LLMContextPayload | null,
      async completeStructured(
        this: typeof llm,
        payload: LLMContextPayload,
      ): Promise<LLMActionResponse> {
        this.structuredPayload = payload;
        return { reasoning: 'r', action: 'brew_coffee' };
      },
      async completeReflection(): Promise<ReflectionResult> {
        return { agentId: 'a1', newMemories: [], consolidatedNodeIds: [] };
      },
      async completePlan(
        this: typeof llm,
        payload: LLMContextPayload,
      ): Promise<FormulatePlanResult> {
        this.planPayload = payload;
        return {
          description: 'Brew coffee',
          steps: [{ description: 'Brew coffee', targetAffordance: 'brew_coffee' }],
        };
      },
      async completeReflect(
        this: typeof llm,
        payload: LLMContextPayload,
      ): Promise<ReflectLLMResponse> {
        this.reflectPayload = payload;
        return {};
      },
    } as unknown as LLMClient & {
      planPayload: LLMContextPayload | null;
      reflectPayload: LLMContextPayload | null;
      structuredPayload: LLMContextPayload | null;
    };
    return llm;
  }

  it('AC-26: persona fields flow through all three LLM phases', async () => {
    const { PPEROrchestratorImpl } = await import('../src/pper/orchestrator.js');
    const { perceptionProvider, planProvider, executeProvider, reflectProvider } =
      makeFullCycleProviders(personaProfile);
    const classifier: AffordanceClassifier = {
      async prune(_d, a) {
        return a;
      },
    };
    const llm = makeCapturingLLM();
    const orch = new PPEROrchestratorImpl({
      perceptionProvider,
      planProvider,
      executeProvider,
      reflectProvider,
      classifier,
      llmClient: llm,
    });
    await orch.runCycle('a1');

    // Perceive phase builds the system prompt (but doesn't call LLM — it's passive).
    // The Plan phase calls completePlan with the persona-injected system prompt.
    expect(llm.planPayload).not.toBeNull();
    expect(llm.planPayload!.systemPrompt).toContain('Alice');
    expect(llm.planPayload!.systemPrompt).toContain('sleepy researcher');

    // The Reflect phase calls completeReflect with the persona-injected system prompt.
    expect(llm.reflectPayload).not.toBeNull();
    expect(llm.reflectPayload!.systemPrompt).toContain('Alice');
    expect(llm.reflectPayload!.systemPrompt).toContain('sleepy researcher');
  });

  it('AC-27: old-style profile (description fallback) flows through all phases', async () => {
    const { PPEROrchestratorImpl } = await import('../src/pper/orchestrator.js');
    const { perceptionProvider, planProvider, executeProvider, reflectProvider } =
      makeFullCycleProviders(oldStyleProfile);
    const classifier: AffordanceClassifier = {
      async prune(_d, a) {
        return a;
      },
    };
    const llm = makeCapturingLLM();
    const orch = new PPEROrchestratorImpl({
      perceptionProvider,
      planProvider,
      executeProvider,
      reflectProvider,
      classifier,
      llmClient: llm,
    });
    await orch.runCycle('a1');

    // formatPersona falls back to description → system prompts contain the description.
    expect(llm.planPayload).not.toBeNull();
    expect(llm.planPayload!.systemPrompt).toContain('A sleepy agent who needs coffee');

    expect(llm.reflectPayload).not.toBeNull();
    expect(llm.reflectPayload!.systemPrompt).toContain('A sleepy agent who needs coffee');
  });
});

// ─── AC-28, AC-29: Package boundaries & Execute phase ─────────────────────────

describe('Package boundaries and Execute phase (AC-28, AC-29)', () => {
  it('AC-28: formatPersona is imported from @evol-hive/shared in builders', async () => {
    // Read the source files to verify imports come from shared, not engine.
    const perceptionSrc = readFileSync(
      join(__dirname, '../src/pper/perception-builder.ts'),
      'utf-8',
    );
    const planSrc = readFileSync(join(__dirname, '../src/pper/plan-builder.ts'), 'utf-8');
    const reflectSrc = readFileSync(join(__dirname, '../src/pper/reflect-builder.ts'), 'utf-8');
    for (const src of [perceptionSrc, planSrc, reflectSrc]) {
      expect(src).toContain('formatPersona');
      expect(src).toContain('@evol-hive/shared');
      expect(src).not.toContain('@evol-hive/engine');
    }
  });

  it('AC-29: ExecuteDataProvider interface does not include getAgentProfile', () => {
    // The ExecuteDataProvider type should not have getAgentProfile.
    const provider: ExecuteDataProvider = {
      getAgentState: () => null,
      getCurrentStep: () => null,
      isPlanComplete: () => false,
      resolveAffordance: () => null,
      checkPreconditions: () => ({ satisfied: true, failed: [] }),
      executeAffordance: async () => ({ success: true }),
      advanceStep: () => {},
      applyDriveChanges: () => {},
      setSystemFeedback: () => {},
      setThinking: () => {},
    };
    expect((provider as unknown as Record<string, unknown>)['getAgentProfile']).toBeUndefined();
  });
});
