/**
 * Spec 064 — executable offers: the plan context (cognition half)
 * ==================================================================
 * #225 finding 2, verified: `buildPlanTools` omits `talk_to` when no target is
 * valid (`plan-builder.ts`), while `social-primary-hint` and `social-directive`
 * were gated on `isSocialPrimary` / `hasAgentsPresent` instead — so in a cycle
 * with agents present and an empty talk enum the model was instructed to call a
 * tool absent from its tool list. Same class as #212, whose first fix the
 * comments record as having made it worse (#229).
 *
 * Spec 064 R2 requires the blocks to name only tools the cycle offers, and R3
 * requires one source of truth for that predicate. These tests read *both* the
 * tool list and the rendered context from the same cycle, so they fail if the
 * two ever diverge again — that is the AC-6 guard, not a text assertion.
 *
 * Engine half (R1 / AC-1): the offered conversation-affordance set per role is
 * asserted in `packages/engine/tests/spec-033-*.test.ts` and
 * `spec-058-eligibility-bound-plan-affordances.test.ts` (participants now see
 * `leave` only — `contribute` withdrawn by decision D1).
 */
import { describe, it, expect } from 'vitest';
import type {
  Affordance,
  AgentSummary,
  PassivePerception,
  PerceptionResult,
  SocialUrgeAssessment,
  ToolDefinition,
} from '@evol-hive/shared';
import { PlanBuilderImpl } from '../src/pper/plan-builder.js';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';

const prunedAffordances: Affordance[] = [
  {
    id: 'brew_coffee',
    label: 'Brew coffee',
    engineEffect: 'brew_coffee',
    preconditions: [],
    effects: { energy: 20 },
  },
];

const CAROL: AgentSummary = {
  agentId: 'agent-carol',
  name: 'Carol',
  currentActivity: 'idle',
  isThinking: false,
};

/**
 * Send-heavy counts (999 sent, 0 received) sit far above `SOCIAL_TALK_CAP`, so
 * `isSocialTalkCapped` excludes Carol and the talk enum comes back empty while
 * agents are still present. The `result` shape is only read for `.urge` and
 * `.factors.reciprocityFactor` (both below the surface/decay thresholds), so a
 * partial stub is cast in rather than constructing the full urge computation.
 */
const CAPPED_URGE = {
  targetAgentId: 'agent-carol',
  sentCount: 999,
  receivedCount: 0,
  result: { urge: 0.1, factors: { reciprocityFactor: 1 } },
} as unknown as SocialUrgeAssessment;

function makePerception(
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

/** Agents present, all talk targets capped → `talk_to` is NOT offered. */
function noValidTarget() {
  return makePerception({ socialUrges: [CAPPED_URGE] }, { agentsPresent: [CAROL] });
}

/** Agents present, no cap → `talk_to` IS offered. */
function withValidTarget() {
  return makePerception({ socialUrges: [] }, { agentsPresent: [CAROL] });
}

/** Social drive dominant, so `social-primary-hint` is emitted too. */
function socialPrimary(perception: PerceptionResult): PerceptionResult {
  return { ...perception, primaryDriveLabel: 'high social urge, need company' };
}

function toolNames(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.function.name);
}

const SOCIAL_TOOLS = ['talk_to', 'observe_agent', 'help', 'ignore'] as const;

describe('spec 064 R2/AC-3 — the context does not name an un-offered talk_to', () => {
  it('AC-3: agents present, no valid talk target → talk_to is neither offered nor mentioned', () => {
    const payload = new PlanBuilderImpl().build(noValidTarget());
    expect(toolNames(payload.tools)).not.toContain('talk_to');
    expect(payload.perceptionContext).not.toContain('talk_to');
  });

  it('AC-3: agents present, a valid talk target → talk_to is offered and mentioned', () => {
    const payload = new PlanBuilderImpl().build(withValidTarget());
    expect(toolNames(payload.tools)).toContain('talk_to');
    expect(payload.perceptionContext).toContain('talk_to');
  });

  it('AC-4: the other social tools stay offered and named when talk_to is withdrawn', () => {
    const payload = new PlanBuilderImpl().build(noValidTarget());
    const names = toolNames(payload.tools);
    for (const tool of ['observe_agent', 'help', 'ignore'] as const) {
      expect(names).toContain(tool);
    }
    // The directive is narrowed, never dropped: its invariant opening survives.
    expect(payload.perceptionContext).toContain('IMPORTANT: Other agents are present.');
  });

  it('AC-4: the social-primary hint is emitted when social is primary, naming only offered tools', () => {
    const payload = new PlanBuilderImpl().build(socialPrimary(noValidTarget()));
    expect(payload.perceptionContext).toContain('Your social drive is your most urgent need.');
    expect(payload.perceptionContext).not.toContain('talk_to');
    expect(payload.perceptionContext).toContain('observe_agent');
  });
});

describe('spec 064 R4/AC-6 — guard: no block names a tool absent from the cycle', () => {
  it('AC-6: every social-tool mention in the context is backed by an offered tool', () => {
    const cycles = [noValidTarget(), withValidTarget(), socialPrimary(noValidTarget())];
    for (const perception of cycles) {
      const payload = new PlanBuilderImpl().build(perception);
      const names = toolNames(payload.tools);
      for (const tool of SOCIAL_TOOLS) {
        if (!names.includes(tool)) {
          // The context must not instruct a tool the cycle does not offer.
          expect(payload.perceptionContext).not.toContain(tool);
        }
      }
    }
  });

  it('AC-5: the tool list and the context flip together from the one computed predicate', () => {
    const withoutTarget = new PlanBuilderImpl().build(noValidTarget());
    const withTarget = new PlanBuilderImpl().build(withValidTarget());
    // Both halves move on the same input — no separate gating to drift apart.
    expect(toolNames(withoutTarget.tools)).not.toContain('talk_to');
    expect(withoutTarget.perceptionContext).not.toContain('talk_to');
    expect(toolNames(withTarget.tools)).toContain('talk_to');
    expect(withTarget.perceptionContext).toContain('talk_to');
  });
});

describe('spec 064 R2 — perception context and the KV-cache system prompt', () => {
  // Discovered while writing the guard above: the PERCEPTION phase carried the
  // same defect at three more sites (a stable line plus two dynamic lines), and
  // the plan phase's system prompt named `talk_to` unconditionally.
  it('AC-3 (perception): no valid target → talk_to is neither offered nor named', () => {
    const payload = new PerceptionBuilderImpl().build(noValidTarget());
    expect(toolNames(payload.tools)).not.toContain('talk_to');
    expect(payload.perceptionContext).not.toContain('talk_to');
  });

  it('AC-3 (perception): a valid target → talk_to is offered and named', () => {
    const payload = new PerceptionBuilderImpl().build(withValidTarget());
    expect(toolNames(payload.tools)).toContain('talk_to');
    expect(payload.perceptionContext).toContain('talk_to');
  });

  it('AC-4 (perception): the always-offered social tools are still named when talk_to is withdrawn', () => {
    const payload = new PerceptionBuilderImpl().build(noValidTarget());
    for (const tool of ['observe_agent', 'help', 'ignore'] as const) {
      expect(payload.perceptionContext).toContain(tool);
    }
  });

  it('AC-3 (system prompt): the KV-cache prefix never names talk_to, since it cannot vary per cycle', () => {
    for (const payload of [
      new PlanBuilderImpl().build(withValidTarget()),
      new PlanBuilderImpl().build(noValidTarget()),
    ]) {
      expect(payload.systemPrompt).not.toContain('talk_to');
    }
  });
});
