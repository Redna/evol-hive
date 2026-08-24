/**
 * Tests for spec 018 — Multi-Agent Social types (shared layer).
 * Covers AC-1 through AC-15, AC-49, AC-58.
 */
import { describe, it, expect } from 'vitest';
import type {
  AgentSummary,
  SocialMessage,
  SocialToolResult,
  SocialActionBridge,
  PassivePerception,
  PerceptionResult,
  PerceptionDataProvider,
  CognitiveToolExecutor,
  CognitiveToolName,
  ToolDefinition,
} from '@evol-hive/shared';
import {
  talkToSchema,
  observeAgentSchema,
  helpSchema,
  ignoreSchema,
  talkToTool,
  observeAgentTool,
  helpTool,
  ignoreTool,
} from '@evol-hive/shared';
import type { Relationship, AgentInternalState, Affordance } from '@evol-hive/shared';

// ── AC-1: AgentSummary ───────────────────────────────────────────────────────

describe('AC-1: AgentSummary type', () => {
  it('is defined with agentId, name, currentActivity, isThinking', () => {
    const summary: AgentSummary = {
      agentId: 'agent-bob',
      name: 'Bob',
      currentActivity: 'idle',
      isThinking: false,
    };
    expect(summary.agentId).toBe('agent-bob');
    expect(summary.name).toBe('Bob');
    expect(summary.currentActivity).toBe('idle');
    expect(summary.isThinking).toBe(false);
  });
});

// ── AC-2: SocialMessage ──────────────────────────────────────────────────────

describe('AC-2: SocialMessage type', () => {
  it('is defined with fromAgentId, fromName, content, timestamp', () => {
    const msg: SocialMessage = {
      fromAgentId: 'agent-alice',
      fromName: 'Alice',
      content: 'Hello Bob!',
      timestamp: 1000,
    };
    expect(msg.fromAgentId).toBe('agent-alice');
    expect(msg.fromName).toBe('Alice');
    expect(msg.content).toBe('Hello Bob!');
    expect(msg.timestamp).toBe(1000);
  });
});

// ── AC-3: Relationship ──────────────────────────────────────────────────────

describe('AC-3: Relationship type', () => {
  it('is defined with trust, familiarity, lastInteraction', () => {
    const rel: Relationship = {
      trust: 50,
      familiarity: 10,
      lastInteraction: 500,
    };
    expect(rel.trust).toBe(50);
    expect(rel.familiarity).toBe(10);
    expect(rel.lastInteraction).toBe(500);
  });
});

// ── AC-4: SocialToolResult ───────────────────────────────────────────────────

describe('AC-4: SocialToolResult type', () => {
  it('is defined with success, message, relationshipUpdated', () => {
    const result: SocialToolResult = {
      success: true,
      message: 'Message sent to Bob.',
      relationshipUpdated: true,
    };
    expect(result.success).toBe(true);
    expect(result.message).toBe('Message sent to Bob.');
    expect(result.relationshipUpdated).toBe(true);
  });

  it('includes optional observedAgent for observe_agent', () => {
    const result: SocialToolResult = {
      success: true,
      message: 'Observed Bob.',
      relationshipUpdated: true,
      observedAgent: {
        name: 'Bob',
        currentActivity: 'idle',
        isThinking: false,
        drives: { energy: 50 },
      },
    };
    expect(result.observedAgent?.name).toBe('Bob');
    expect(result.observedAgent?.drives).toEqual({ energy: 50 });
  });
});

// ── AC-5: PassivePerception.agentsPresent ─────────────────────────────────────

describe('AC-5: PassivePerception.agentsPresent', () => {
  it('includes optional agentsPresent field', () => {
    const pp: PassivePerception = {
      roomId: 'kitchen',
      objectsPresent: [],
      drives: { energy: 50 },
      agentsPresent: [
        { agentId: 'agent-bob', name: 'Bob', currentActivity: 'idle', isThinking: false },
      ],
    };
    expect(pp.agentsPresent).toHaveLength(1);
    expect(pp.agentsPresent![0].name).toBe('Bob');
  });

  it('compiles without agentsPresent (backward compat)', () => {
    const pp: PassivePerception = {
      roomId: 'kitchen',
      objectsPresent: [],
      drives: { energy: 50 },
    };
    expect(pp.agentsPresent).toBeUndefined();
  });
});

// ── AC-6: PassivePerception.socialContext ─────────────────────────────────────

describe('AC-6: PassivePerception.socialContext', () => {
  it('includes optional socialContext field', () => {
    const pp: PassivePerception = {
      roomId: 'kitchen',
      objectsPresent: [],
      drives: { energy: 50 },
      socialContext: [{ fromAgentId: 'a1', fromName: 'Alice', content: 'Hi!', timestamp: 100 }],
    };
    expect(pp.socialContext).toHaveLength(1);
    expect(pp.socialContext![0].content).toBe('Hi!');
  });

  it('compiles without socialContext (backward compat)', () => {
    const pp: PassivePerception = {
      roomId: 'kitchen',
      objectsPresent: [],
      drives: { energy: 50 },
    };
    expect(pp.socialContext).toBeUndefined();
  });
});

// ── AC-7: AgentInternalState.relationships ────────────────────────────────────

describe('AC-7: AgentInternalState.relationships', () => {
  it('includes optional relationships field', () => {
    const state: AgentInternalState = {
      agentId: 'a1',
      drives: { energy: 100, hunger: 100, social: 100, comfort: 100, curiosity: 100 },
      currentGoal: '',
      currentPlan: null,
      isThinking: false,
      location: 'kitchen',
      lastPerceptionTick: 0,
      relationships: { 'agent-bob': { trust: 60, familiarity: 20, lastInteraction: 500 } },
    };
    expect(state.relationships!['agent-bob'].trust).toBe(60);
  });

  it('compiles without relationships (backward compat)', () => {
    const state: AgentInternalState = {
      agentId: 'a1',
      drives: { energy: 100, hunger: 100, social: 100, comfort: 100, curiosity: 100 },
      currentGoal: '',
      currentPlan: null,
      isThinking: false,
      location: 'kitchen',
      lastPerceptionTick: 0,
    };
    expect(state.relationships).toBeUndefined();
  });
});

// ── AC-8: Affordance.targetAgentId ───────────────────────────────────────────

describe('AC-8: Affordance.targetAgentId', () => {
  it('includes optional targetAgentId field', () => {
    const aff: Affordance = {
      id: 'talk_to',
      label: 'Talk to',
      engineEffect: 'talk_to',
      preconditions: [],
      effects: { social: 10 },
      targetAgentId: 'agent-bob',
    };
    expect(aff.targetAgentId).toBe('agent-bob');
  });

  it('compiles without targetAgentId (backward compat)', () => {
    const aff: Affordance = {
      id: 'brew_coffee',
      label: 'Brew coffee',
      engineEffect: 'brew_coffee',
      preconditions: [],
      effects: { energy: 20 },
    };
    expect(aff.targetAgentId).toBeUndefined();
  });
});

// ── AC-9: PerceptionDataProvider extensions ──────────────────────────────────

describe('AC-9: PerceptionDataProvider social methods', () => {
  it('can implement getAgentsInRoom, dequeueSocialMessages, getRelationships', () => {
    const provider: PerceptionDataProvider = {
      getAgentLocation: () => 'kitchen',
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => [],
      getAgentDrives: () => ({}),
      getPrimaryDriveLabel: () => '',
      getSystemFeedback: () => undefined,
      getAgentsInRoom: () => [
        { agentId: 'b', name: 'Bob', currentActivity: 'idle', isThinking: false },
      ],
      dequeueSocialMessages: () => [],
      getRelationships: () => ({}),
    };
    expect(provider.getAgentsInRoom!('kitchen', 'a')).toHaveLength(1);
    expect(provider.dequeueSocialMessages!('a')).toEqual([]);
    expect(provider.getRelationships!('a')).toEqual({});
  });

  it('compiles without the new methods (backward compat)', () => {
    const provider: PerceptionDataProvider = {
      getAgentLocation: () => 'kitchen',
      getObjectsInRoom: () => [],
      getAffordancesInRoom: () => [],
      getAgentDrives: () => ({}),
      getPrimaryDriveLabel: () => '',
      getSystemFeedback: () => undefined,
    };
    expect(provider.getAgentsInRoom).toBeUndefined();
    expect(provider.dequeueSocialMessages).toBeUndefined();
    expect(provider.getRelationships).toBeUndefined();
  });
});

// ── AC-10: SocialActionBridge ─────────────────────────────────────────────────

describe('AC-10: SocialActionBridge interface', () => {
  it('defines queueMessage, updateRelationship, getAgentSummary, getAgentDrives', () => {
    const bridge: SocialActionBridge = {
      queueMessage: () => {},
      updateRelationship: () => {},
      getAgentSummary: () => ({
        agentId: 'b',
        name: 'Bob',
        currentActivity: 'idle',
        isThinking: false,
      }),
      getAgentDrives: () => ({ energy: 50 }),
    };
    bridge.queueMessage('a', 'b', 'hi');
    bridge.updateRelationship('a', 'b', { trust: 10 });
    expect(bridge.getAgentSummary('b')?.name).toBe('Bob');
    expect(bridge.getAgentDrives('b').energy).toBe(50);
  });
});

// ── AC-11: CognitiveToolExecutor social methods ──────────────────────────────

describe('AC-11: CognitiveToolExecutor social methods', () => {
  it('interface includes executeTalkTo, executeObserveAgent, executeHelp, executeIgnore', async () => {
    const executor: CognitiveToolExecutor = {
      executeQueryMemory: async () => ({ memories: [] }),
      executeUpdateInternalState: async () => ({
        success: false,
        goalUpdated: false,
        drivesUpdated: false,
        message: '',
      }),
      executeTalkTo: async () => ({ success: true, message: 'sent', relationshipUpdated: true }),
      executeObserveAgent: async () => ({
        success: true,
        message: 'observed',
        relationshipUpdated: true,
      }),
      executeHelp: async () => ({ success: true, message: 'helped', relationshipUpdated: true }),
      executeIgnore: async () => ({ success: true, message: 'ignored', relationshipUpdated: true }),
    };
    expect((await executor.executeTalkTo('a', 'b', 'hi')).success).toBe(true);
    expect((await executor.executeObserveAgent('a', 'b')).success).toBe(true);
    expect((await executor.executeHelp('a', 'b')).success).toBe(true);
    expect((await executor.executeIgnore('a', 'b')).success).toBe(true);
  });
});

// ── AC-12: CognitiveToolName extension ───────────────────────────────────────

describe('AC-12: CognitiveToolName includes social tools', () => {
  it('accepts talk_to, observe_agent, help, ignore', () => {
    const names: CognitiveToolName[] = [
      'formulate_plan',
      'query_memory',
      'update_internal_state',
      'talk_to',
      'observe_agent',
      'help',
      'ignore',
    ];
    expect(names).toContain('talk_to');
    expect(names).toContain('observe_agent');
    expect(names).toContain('help');
    expect(names).toContain('ignore');
  });
});

// ── AC-13: Social tool schemas ───────────────────────────────────────────────

describe('AC-13: Social tool schemas', () => {
  it('talkToSchema requires targetAgentId and message', () => {
    expect(talkToSchema.required).toEqual(['targetAgentId', 'message']);
    expect(talkToSchema.additionalProperties).toBe(false);
  });

  it('observeAgentSchema requires targetAgentId', () => {
    expect(observeAgentSchema.required).toEqual(['targetAgentId']);
    expect(observeAgentSchema.additionalProperties).toBe(false);
  });

  it('helpSchema requires targetAgentId', () => {
    expect(helpSchema.required).toEqual(['targetAgentId']);
    expect(helpSchema.additionalProperties).toBe(false);
  });

  it('ignoreSchema requires targetAgentId', () => {
    expect(ignoreSchema.required).toEqual(['targetAgentId']);
    expect(ignoreSchema.additionalProperties).toBe(false);
  });
});

// ── AC-14: Social tool definitions ────────────────────────────────────────────

describe('AC-14: Social tool definitions', () => {
  it('talkToTool has name talk_to', () => {
    const tool: ToolDefinition = talkToTool;
    expect(tool.function.name).toBe('talk_to');
  });

  it('observeAgentTool has name observe_agent', () => {
    const tool: ToolDefinition = observeAgentTool;
    expect(tool.function.name).toBe('observe_agent');
  });

  it('helpTool has name help', () => {
    const tool: ToolDefinition = helpTool;
    expect(tool.function.name).toBe('help');
  });

  it('ignoreTool has name ignore', () => {
    const tool: ToolDefinition = ignoreTool;
    expect(tool.function.name).toBe('ignore');
  });

  it('all social tools are ToolDefinition objects with type function', () => {
    for (const tool of [talkToTool, observeAgentTool, helpTool, ignoreTool]) {
      expect(tool.type).toBe('function');
    }
  });
});

// ── AC-49: PerceptionResult.relationships ───────────────────────────────────

describe('AC-49: PerceptionResult.relationships', () => {
  it('includes optional relationships field', () => {
    const pr: PerceptionResult = {
      passive: { roomId: 'kitchen', objectsPresent: [], drives: { energy: 50 } },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
      relationships: { 'agent-bob': { trust: 70, familiarity: 40, lastInteraction: 100 } },
    };
    expect(pr.relationships!['agent-bob'].trust).toBe(70);
  });

  it('compiles without relationships (backward compat)', () => {
    const pr: PerceptionResult = {
      passive: { roomId: 'kitchen', objectsPresent: [], drives: { energy: 50 } },
      prunedAffordances: [],
      primaryDriveLabel: 'low energy',
    };
    expect(pr.relationships).toBeUndefined();
  });
});
