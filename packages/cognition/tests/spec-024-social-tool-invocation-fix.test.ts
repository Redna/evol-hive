/**
 * Tests for spec 024 — Social Tool Invocation Fix.
 * Covers AC-1 through AC-22 (unit/integration). AC-23–25 are diagnostic/runtime
 * criteria verified manually against a live LLM and are not unit-tested here.
 */
import { describe, it, expect } from 'vitest';
import type {
  Affordance,
  PassivePerception,
  PerceptionResult,
  AgentProfile,
} from '@evol-hive/shared';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';
import { defaultCognitiveTools } from '../src/tools/index.js';
import { cognitiveToolsToToolDefinitions } from '../src/tools/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const prunedAffordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
  },
];

function makePerceptionResult(
  overrides: Partial<PerceptionResult> = {},
  passiveOverrides: Partial<PassivePerception> = {},
): PerceptionResult {
  const passive: PassivePerception = {
    roomId: 'kitchen',
    objectsPresent: [{ objectId: 'coffee-1', name: 'Coffee Machine', type: 'appliance' }],
    drives: { energy: 10, social: 80 },
    ...passiveOverrides,
  };
  return {
    passive,
    prunedAffordances,
    primaryDriveLabel: 'low energy, need to restore energy',
    ...overrides,
  };
}

function makeAgentsPresent() {
  return [
    {
      agentId: 'agent-carol',
      name: 'Carol',
      currentActivity: 'idle',
      isThinking: false,
    },
  ];
}

const SOCIAL_DIRECTIVE_PLAN =
  'IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or ignore directly to interact with them. Do not use formulate_plan for social actions.';
const SOCIAL_DIRECTIVE_PERCEPTION =
  'IMPORTANT: Other agents are present. Call talk_to, observe_agent, help, or ignore directly to interact with them.';
const STRENGTHENED_HINT =
  'Your social drive is your most urgent need. Call talk_to or help NOW to interact with another agent in this room. Do not formulate a plan first.';
const OLD_HINT =
  'You feel a strong need for social interaction. Consider using talk_to or help to engage with other agents in the room.';
const SYSTEM_PROMPT_DIRECTIVE =
  'When other agents are present and your social drive is urgent, call talk_to, observe_agent, help, or ignore directly — do not use formulate_plan for social actions.';

function toolNames(tools: { function: { name: string } }[]): string[] {
  return tools.map((t) => t.function.name);
}

// ── PlanBuilder tool ordering ───────────────────────────────────────────────

describe('PlanBuilder — tool ordering (spec 024)', () => {
  const builder = new PlanBuilderImpl();

  // AC-1: social tools first when agents present (non-social primary drive)
  it('AC-1: agents present → social tools are first four, then formulate_plan, cognitive, affordance', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low energy, need to restore energy' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    const names = toolNames(payload.tools);
    expect(names[0]).toBe('talk_to');
    expect(names[1]).toBe('observe_agent');
    expect(names[2]).toBe('help');
    expect(names[3]).toBe('ignore');
    expect(names[4]).toBe('formulate_plan');
    expect(names[5]).toBe('query_memory');
    expect(names[6]).toBe('update_internal_state');
    // Affordance tools follow
    expect(names[7]).toBe('brew_coffee');
  });

  // AC-2: no agents → unchanged
  it('AC-2: no agents → starts with formulate_plan, query_memory, update_internal_state, affordances', () => {
    const pr = makePerceptionResult();
    const payload = builder.build(pr);
    const names = toolNames(payload.tools);
    expect(names[0]).toBe('formulate_plan');
    expect(names[1]).toBe('query_memory');
    expect(names[2]).toBe('update_internal_state');
    expect(names[3]).toBe('brew_coffee');
    // No social tools at all
    expect(names).not.toContain('talk_to');
    expect(names).not.toContain('observe_agent');
    expect(names).not.toContain('help');
    expect(names).not.toContain('ignore');
  });

  // AC-3: agents present + social primary drive → formulate_plan is LAST
  it('AC-3: agents present + social drive → formulate_plan is the LAST tool', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low social, need social interaction' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    const names = toolNames(payload.tools);
    const lastIndex = names.length - 1;
    expect(names[lastIndex]).toBe('formulate_plan');
  });

  // AC-4: agents present + social primary drive → first four are social tools
  it('AC-4: agents present + social drive → first four are social tools', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low social, need social interaction' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    const names = toolNames(payload.tools);
    expect(names[0]).toBe('talk_to');
    expect(names[1]).toBe('observe_agent');
    expect(names[2]).toBe('help');
    expect(names[3]).toBe('ignore');
  });

  // AC-3 detail: confirm ordering for the social case is exactly as specified
  it('AC-3 detail: social case ordering = [social, cognitive, affordance, formulate_plan]', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low social, need social interaction' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    const names = toolNames(payload.tools);
    expect(names).toEqual([
      'talk_to',
      'observe_agent',
      'help',
      'ignore',
      'query_memory',
      'update_internal_state',
      'brew_coffee',
      'formulate_plan',
    ]);
  });
});

// ── PlanBuilder directive in user message ──────────────────────────────────

describe('PlanBuilder — social directive in perceptionContext (spec 024)', () => {
  const builder = new PlanBuilderImpl();

  // AC-5: agents present → directive included
  it('AC-5: agents present → includes the plan social directive', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low energy, need to restore energy' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    expect(payload.perceptionContext).toContain(SOCIAL_DIRECTIVE_PLAN);
  });

  // AC-6: no agents → no directive
  it('AC-6: no agents → does NOT include the social directive', () => {
    const pr = makePerceptionResult();
    const payload = builder.build(pr);
    expect(payload.perceptionContext).not.toContain(SOCIAL_DIRECTIVE_PLAN);
    expect(payload.perceptionContext).not.toContain('IMPORTANT: Other agents are present');
  });
});

// ── PlanBuilder strengthened social hint ────────────────────────────────────

describe('PlanBuilder — strengthened social hint (spec 024)', () => {
  const builder = new PlanBuilderImpl();

  // AC-7: agents present + social drive → strengthened hint present, old hint absent
  it('AC-7: agents present + social drive → includes strengthened hint, not old hint', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low social, need social interaction' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    expect(payload.perceptionContext).toContain(STRENGTHENED_HINT);
    expect(payload.perceptionContext).not.toContain(OLD_HINT);
  });

  // AC-8: agents present + non-social drive → neither strengthened nor old hint
  it('AC-8: agents present + non-social drive → no social hint at all', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low energy, need to restore energy' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    expect(payload.perceptionContext).not.toContain(STRENGTHENED_HINT);
    expect(payload.perceptionContext).not.toContain(OLD_HINT);
  });
});

// ── PlanBuilder system prompt directive ─────────────────────────────────────

describe('PlanBuilder — system prompt directive (spec 024)', () => {
  const builder = new PlanBuilderImpl();

  // AC-9: agents present → system prompt includes directive
  it('AC-9: agents present → system prompt includes social directive', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low energy, need to restore energy' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    expect(payload.systemPrompt).toContain(SYSTEM_PROMPT_DIRECTIVE);
  });

  // AC-10: no agents → system prompt unchanged (no directive)
  it('AC-10: no agents → system prompt does NOT include directive', () => {
    const pr = makePerceptionResult();
    const payload = builder.build(pr);
    expect(payload.systemPrompt).not.toContain(SYSTEM_PROMPT_DIRECTIVE);
    expect(payload.systemPrompt).not.toContain('do not use formulate_plan for social actions');
  });

  // AC-10 detail: with persona, agents present → directive appended
  it('AC-9 persona: persona + agents present → system prompt includes directive', () => {
    const persona: AgentProfile = { name: 'Alice', role: 'barista', traits: ['friendly'] };
    const pr = makePerceptionResult(
      { persona, primaryDriveLabel: 'low energy, need to restore energy' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    expect(payload.systemPrompt).toContain('You are Alice');
    expect(payload.systemPrompt).toContain(SYSTEM_PROMPT_DIRECTIVE);
  });

  // AC-10 detail: with persona, no agents → no directive
  it('AC-10 persona: persona + no agents → system prompt does NOT include directive', () => {
    const persona: AgentProfile = { name: 'Alice', role: 'barista', traits: ['friendly'] };
    const pr = makePerceptionResult({ persona });
    const payload = builder.build(pr);
    expect(payload.systemPrompt).toContain('You are Alice');
    expect(payload.systemPrompt).not.toContain(SYSTEM_PROMPT_DIRECTIVE);
  });

  // KV cache: no-agents system prompt is byte-identical regardless of drive label
  it('AC-10 KV: no-agents system prompt is identical regardless of drive label', () => {
    const pr1 = makePerceptionResult({ primaryDriveLabel: 'low social, need social' });
    const pr2 = makePerceptionResult({ primaryDriveLabel: 'low energy, need energy' });
    const payload1 = builder.build(pr1);
    const payload2 = builder.build(pr2);
    expect(payload1.systemPrompt).toBe(payload2.systemPrompt);
  });
});

// ── PerceptionBuilder tool ordering ─────────────────────────────────────────

describe('PerceptionBuilder — tool ordering (spec 024)', () => {
  const builder = new PerceptionBuilderImpl();

  // AC-11: agents present (normal) → social tools first
  it('AC-11: agents present → social tools first, then cognitive, then affordance', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low energy, need to restore energy' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    const names = toolNames(payload.tools);
    expect(names[0]).toBe('talk_to');
    expect(names[1]).toBe('observe_agent');
    expect(names[2]).toBe('help');
    expect(names[3]).toBe('ignore');
    expect(names[4]).toBe('query_memory');
    expect(names[5]).toBe('update_internal_state');
    expect(names[6]).toBe('brew_coffee');
  });

  // AC-12: agents present + masking active → social tools first, then cognitive tools
  it('AC-12: agents present + masking active → social tools first, then cognitive tools', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low energy, need to restore energy' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr, { hasPlan: false, maskingEnabled: true });
    const names = toolNames(payload.tools);
    expect(names[0]).toBe('talk_to');
    expect(names[1]).toBe('observe_agent');
    expect(names[2]).toBe('help');
    expect(names[3]).toBe('ignore');
    // Remaining should be the cognitive tool definitions (includes formulate_plan in masked path)
    const expectedCognitive = cognitiveToolsToToolDefinitions(defaultCognitiveTools).map(
      (t) => t.function.name,
    );
    expect(names.slice(0, 4)).toEqual(['talk_to', 'observe_agent', 'help', 'ignore']);
    expect(names.slice(4)).toEqual(expectedCognitive);
  });

  // AC-13: no agents → no social tools
  it('AC-13: no agents → no social tools in array', () => {
    const pr = makePerceptionResult();
    const payload = builder.build(pr);
    const names = toolNames(payload.tools);
    expect(names).not.toContain('talk_to');
    expect(names).not.toContain('observe_agent');
    expect(names).not.toContain('help');
    expect(names).not.toContain('ignore');
  });
});

// ── PerceptionBuilder directive ─────────────────────────────────────────────

describe('PerceptionBuilder — social directive (spec 024)', () => {
  const builder = new PerceptionBuilderImpl();

  // AC-14: agents present → directive (perception variant, no formulate_plan clause)
  it('AC-14: agents present → includes perception social directive', () => {
    const pr = makePerceptionResult(
      { primaryDriveLabel: 'low energy, need to restore energy' },
      { agentsPresent: makeAgentsPresent() },
    );
    const payload = builder.build(pr);
    expect(payload.perceptionContext).toContain(SOCIAL_DIRECTIVE_PERCEPTION);
  });

  // AC-15: no agents → no directive
  it('AC-15: no agents → does NOT include the social directive', () => {
    const pr = makePerceptionResult();
    const payload = builder.build(pr);
    expect(payload.perceptionContext).not.toContain(SOCIAL_DIRECTIVE_PERCEPTION);
    expect(payload.perceptionContext).not.toContain('IMPORTANT: Other agents are present');
  });
});

// ── Package boundaries (AC-16) ───────────────────────────────────────────────

describe('AC-16: No changes outside cognition package', () => {
  it('shared package source files are unchanged (no social-directive strings)', async () => {
    // The directive strings introduced by spec 024 should not appear in shared.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const testFileDir = path.dirname(fileURLToPath(import.meta.url));
    const sharedDir = path.resolve(testFileDir, '../../shared/src');
    const files: string[] = [];
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    }
    walk(sharedDir);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      expect(content).not.toContain(STRENGTHENED_HINT);
      expect(content).not.toContain(SOCIAL_DIRECTIVE_PLAN);
    }
  });
});

// ── COGNITIVE_TOOL_NAMES unchanged (AC-17) ──────────────────────────────────

describe('AC-17: COGNITIVE_TOOL_NAMES unchanged', () => {
  it('openai-client.ts COGNITIVE_TOOL_NAMES still contains all six tool names', async () => {
    const source = (await import('../src/llm/openai-client.js?raw')) as unknown as {
      default: string;
    };
    const code = source.default ?? '';
    // The set should include all six names.
    expect(code).toMatch(/'query_memory'/);
    expect(code).toMatch(/'update_internal_state'/);
    expect(code).toMatch(/'talk_to'/);
    expect(code).toMatch(/'observe_agent'/);
    expect(code).toMatch(/'help'/);
    expect(code).toMatch(/'ignore'/);
    // Should NOT include formulate_plan or choose_action in COGNITIVE_TOOL_NAMES.
    const setBlock = code.match(/COGNITIVE_TOOL_NAMES\s*=\s*new\s+Set[^[]*\[([\s\S]*?)\]/);
    expect(setBlock).toBeTruthy();
    const setContents = setBlock![1];
    expect(setContents).not.toContain('formulate_plan');
    expect(setContents).not.toContain('choose_action');
  });
});

// ── CognitiveToolExecutor unchanged (AC-18) ─────────────────────────────────

describe('AC-18: CognitiveToolExecutor interface unchanged', () => {
  it('CognitiveToolExecutor interface still has the six methods', async () => {
    const source = (await import('../src/tools/cognitive-tool-executor.js?raw')) as unknown as {
      default: string;
    };
    const code = source.default ?? '';
    expect(code).toMatch(/executeQueryMemory/);
    expect(code).toMatch(/executeUpdateInternalState/);
    expect(code).toMatch(/executeTalkTo/);
    expect(code).toMatch(/executeObserveAgent/);
    expect(code).toMatch(/executeHelp/);
    expect(code).toMatch(/executeIgnore/);
  });
});

// ── Integration: AC-20 (two agents, social drive, mock LLM picks first tool) ─

describe('AC-20: Integration — two agents, social drive, first tool is talk_to', () => {
  it('PlanBuilder payload: social tools first, formulate_plan last, directive + strengthened hint', () => {
    const builder = new PlanBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'living_room',
        objectsPresent: [{ objectId: 'sofa-1', name: 'Sofa', type: 'furniture' }],
        drives: { social: 5, energy: 70 },
        agentsPresent: [
          { agentId: 'agent-carol', name: 'Carol', currentActivity: 'idle', isThinking: false },
        ],
      },
      prunedAffordances: [
        {
          id: 'sit_on_sofa',
          label: 'Sit on sofa',
          engineEffect: 'sit_on_sofa',
          preconditions: [],
          effects: { comfort: 10 },
        },
      ],
      primaryDriveLabel: 'low social, need social interaction',
    };
    const payload = builder.build(pr);

    const names = toolNames(payload.tools);
    expect(names[0]).toBe('talk_to');
    expect(names[names.length - 1]).toBe('formulate_plan');
    expect(payload.systemPrompt).toContain(SYSTEM_PROMPT_DIRECTIVE);
    expect(payload.perceptionContext).toContain(STRENGTHENED_HINT);
    expect(payload.perceptionContext).toContain(SOCIAL_DIRECTIVE_PLAN);

    // Simulate a mock LLM that always picks the first tool in the array.
    const firstToolName = names[0];
    expect(firstToolName).toBe('talk_to');
  });
});

// ── Integration: AC-21 (two agents, non-social drive) ────────────────────────

describe('AC-21: Integration — two agents, non-social drive', () => {
  it('PlanBuilder payload: social tools first, formulate_plan in normal position, no strengthened hint', () => {
    const builder = new PlanBuilderImpl();
    const pr: PerceptionResult = {
      passive: {
        roomId: 'living_room',
        objectsPresent: [{ objectId: 'fridge-1', name: 'Fridge', type: 'appliance' }],
        drives: { social: 70, energy: 5 },
        agentsPresent: [
          { agentId: 'agent-carol', name: 'Carol', currentActivity: 'idle', isThinking: false },
        ],
      },
      prunedAffordances: [
        {
          id: 'eat_food',
          label: 'Eat food',
          engineEffect: 'eat_food',
          preconditions: [],
          effects: { energy: 30 },
        },
      ],
      primaryDriveLabel: 'low energy, need to restore energy',
    };
    const payload = builder.build(pr);

    const names = toolNames(payload.tools);
    // Social tools first
    expect(names.slice(0, 4)).toEqual(['talk_to', 'observe_agent', 'help', 'ignore']);
    // formulate_plan in normal position (after social, before cognitive tools)
    const fpIndex = names.indexOf('formulate_plan');
    expect(fpIndex).toBe(4);
    // Strengthened hint absent
    expect(payload.perceptionContext).not.toContain(STRENGTHENED_HINT);
    // But social directive IS present (agents present regardless of drive)
    expect(payload.perceptionContext).toContain(SOCIAL_DIRECTIVE_PLAN);
    expect(payload.systemPrompt).toContain(SYSTEM_PROMPT_DIRECTIVE);
  });
});

// ── Backward compatibility (AC-22) ───────────────────────────────────────────

describe('AC-22: Backward compatibility — no agents case unchanged', () => {
  const planBuilder = new PlanBuilderImpl();
  const perceptionBuilder = new PerceptionBuilderImpl();

  it('PlanBuilder no-agents: tool order starts with formulate_plan (unchanged)', () => {
    const pr = makePerceptionResult();
    const payload = planBuilder.build(pr);
    const names = toolNames(payload.tools);
    expect(names[0]).toBe('formulate_plan');
    expect(names[1]).toBe('query_memory');
    expect(names[2]).toBe('update_internal_state');
  });

  it('PlanBuilder no-agents: no social directive in context or system prompt', () => {
    const pr = makePerceptionResult();
    const payload = planBuilder.build(pr);
    expect(payload.perceptionContext).not.toContain(SOCIAL_DIRECTIVE_PLAN);
    expect(payload.systemPrompt).not.toContain(SYSTEM_PROMPT_DIRECTIVE);
  });

  it('PerceptionBuilder no-agents: no social tools, no directive', () => {
    const pr = makePerceptionResult();
    const payload = perceptionBuilder.build(pr);
    const names = toolNames(payload.tools);
    expect(names).not.toContain('talk_to');
    expect(payload.perceptionContext).not.toContain(SOCIAL_DIRECTIVE_PERCEPTION);
  });

  it('PerceptionBuilder no-agents: tool order starts with query_memory (unchanged)', () => {
    const pr = makePerceptionResult();
    const payload = perceptionBuilder.build(pr);
    const names = toolNames(payload.tools);
    expect(names[0]).toBe('query_memory');
    expect(names[1]).toBe('update_internal_state');
    expect(names[2]).toBe('brew_coffee');
  });
});
