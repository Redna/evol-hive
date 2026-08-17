/**
 * Tests for the Agent Persona System — shared layer (spec 012).
 * Covers AC-1 through AC-8 (shared types & formatPersona).
 */
import { describe, it, expect } from 'vitest';
import type { AgentProfile, PerceptionDataProvider, ReflectDataProvider } from '@evol-hive/shared';
import { formatPersona } from '@evol-hive/shared';
import type { PersonaText } from '@evol-hive/shared';

// ─── AC-1: AgentProfile persona fields ──────────────────────────────────────

describe('AgentProfile persona fields (AC-1)', () => {
  it('accepts the new optional persona fields', () => {
    const profile: AgentProfile = {
      id: 'alice',
      name: 'Alice',
      description: 'A researcher',
      traits: ['diligent'],
      initialDrives: { energy: 50 },
      backstory: 'A caffeine-dependent researcher',
      longTermGoals: ['finish thesis'],
      behavioralTendencies: ['risk-averse', 'methodical'],
      speechStyle: 'precise and academic',
      relationships: { 'agent-bob': 'trusted colleague' },
    };
    expect(profile.backstory).toBe('A caffeine-dependent researcher');
    expect(profile.longTermGoals).toEqual(['finish thesis']);
    expect(profile.behavioralTendencies).toEqual(['risk-averse', 'methodical']);
    expect(profile.speechStyle).toBe('precise and academic');
    expect(profile.relationships).toEqual({ 'agent-bob': 'trusted colleague' });
  });

  it('compiles without any new persona fields (backward compatible)', () => {
    const profile: AgentProfile = {
      id: 'alice',
      name: 'Alice',
      description: 'A sleepy agent who needs coffee',
      traits: ['diligent'],
      initialDrives: { energy: 50 },
    };
    expect(profile.name).toBe('Alice');
  });
});

// ─── AC-2: PersonaText type ──────────────────────────────────────────────────

describe('PersonaText type (AC-2)', () => {
  it('is a string alias', () => {
    const text: PersonaText = 'some persona text';
    expect(typeof text).toBe('string');
  });
});

// ─── AC-3: formatPersona with all fields ──────────────────────────────────────

describe('formatPersona — full profile (AC-3)', () => {
  const profile: AgentProfile = {
    id: 'alice',
    name: 'Alice',
    description: 'A diligent researcher',
    traits: ['diligent', 'caffeine-dependent'],
    initialDrives: {},
    backstory: 'A diligent researcher who runs on coffee',
    behavioralTendencies: ['risk-averse', 'methodical'],
    speechStyle: 'precise and academic',
    longTermGoals: ['finish thesis'],
    relationships: { 'agent-bob': 'trusted colleague' },
  };

  const result = formatPersona(profile);

  it('contains the name', () => {
    expect(result).toContain('Alice');
  });

  it('contains the backstory', () => {
    expect(result).toContain('diligent researcher who runs on coffee');
  });

  it('contains the traits', () => {
    expect(result).toContain('diligent');
    expect(result).toContain('caffeine-dependent');
  });

  it('contains the behavioral tendencies', () => {
    expect(result).toContain('risk-averse');
    expect(result).toContain('methodical');
  });

  it('contains the speech style', () => {
    expect(result).toContain('precise and academic');
  });

  it('contains the long-term goals', () => {
    expect(result).toContain('finish thesis');
  });

  it('contains the relationship description', () => {
    expect(result).toContain('trusted colleague');
  });

  it('never returns an empty string', () => {
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── AC-4: formatPersona falls back to description ───────────────────────────

describe('formatPersona — description fallback (AC-4)', () => {
  it('returns the description when only name and description are set', () => {
    const profile: AgentProfile = {
      id: 'alice',
      name: 'Alice',
      description: 'A sleepy agent who needs coffee',
      traits: [],
      initialDrives: {},
    };
    expect(formatPersona(profile)).toBe('A sleepy agent who needs coffee');
  });

  it('returns the description when traits are non-empty but no new persona fields (AC-4)', () => {
    const profile: AgentProfile = {
      id: 'alice',
      name: 'Alice',
      description: 'A sleepy agent who needs coffee',
      traits: ['diligent'],
      initialDrives: {},
    };
    // traits is an existing field — with no new persona fields, falls back to description.
    expect(formatPersona(profile)).toBe('A sleepy agent who needs coffee');
  });
});

// ─── AC-5: formatPersona falls back to name ──────────────────────────────────

describe('formatPersona — name fallback (AC-5)', () => {
  it('returns the name when no persona fields and no description', () => {
    const profile: AgentProfile = {
      id: 'alice',
      name: 'Alice',
      description: '',
      traits: [],
      initialDrives: {},
    };
    expect(formatPersona(profile)).toBe('Alice');
  });
});

// ─── AC-6: getAgentProfile on PerceptionDataProvider ─────────────────────────

describe('PerceptionDataProvider.getAgentProfile (AC-6)', () => {
  it('interface includes getAgentProfile(agentId): AgentProfile | null', () => {
    const provider: PerceptionDataProvider = {
      getAgentLocation: () => 'kitchen',
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => [],
      getAgentDrives: () => ({}),
      getPrimaryDriveLabel: () => '',
      getSystemFeedback: () => undefined,
      getAgentProfile: (agentId: string) => {
        if (agentId === 'alice') {
          return {
            id: 'alice',
            name: 'Alice',
            description: '',
            traits: [],
            initialDrives: {},
          };
        }
        return null;
      },
    };
    expect(provider.getAgentProfile('alice')?.name).toBe('Alice');
    expect(provider.getAgentProfile('unknown')).toBeNull();
  });
});

// ─── AC-7: getAgentProfile on ReflectDataProvider ─────────────────────────────

describe('ReflectDataProvider.getAgentProfile (AC-7)', () => {
  it('interface includes getAgentProfile(agentId): AgentProfile | null', () => {
    const provider: ReflectDataProvider = {
      getAgentState: () => null,
      applyDriveChanges: () => {},
      updateGoal: () => {},
      storeMemory: async () => {},
      clearPlanIfComplete: () => false,
      setThinking: () => {},
      getAgentProfile: (agentId: string) => {
        if (agentId === 'alice') {
          return {
            id: 'alice',
            name: 'Alice',
            description: '',
            traits: [],
            initialDrives: {},
          };
        }
        return null;
      },
    };
    expect(provider.getAgentProfile('alice')?.name).toBe('Alice');
    expect(provider.getAgentProfile('unknown')).toBeNull();
  });
});

// ─── AC-8: persona field on PerceptionResult ─────────────────────────────────

describe('PerceptionResult.persona field (AC-8)', () => {
  it('accepts an optional persona field', () => {
    const result = {
      passive: { roomId: 'kitchen', objectsPresent: [], drives: {} },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
      persona: {
        id: 'alice',
        name: 'Alice',
        description: '',
        traits: [],
        initialDrives: {},
      },
    };
    expect(result.persona?.name).toBe('Alice');
  });

  it('accepts persona: null', () => {
    const result = {
      passive: { roomId: 'kitchen', objectsPresent: [], drives: {} },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
      persona: null,
    };
    expect(result.persona).toBeNull();
  });

  it('compiles without persona field (backward compatible)', () => {
    const result = {
      passive: { roomId: 'kitchen', objectsPresent: [], drives: {} },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
    };
    expect(result.persona).toBeUndefined();
  });
});
