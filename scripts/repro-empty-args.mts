/**
 * scripts/repro-empty-args — isolate the deterministic empty-args failure
 * (issue #140 arc follow-up): gemma4 emits formulate_plan with `args: {}`
 * ~100% for apprentice-1, ~5% for gardener-1. Bisect the payload.
 *
 * Variants (each sent N times): persona (Tomas vs Maren) × drives (zero vs
 * mid) × anti-repeat directive (on/off) × systemFeedback (on/off).
 */
import type { Affordance, PerceptionResult } from '../packages/shared/src/index.js';
import { PlanBuilderImpl } from '../packages/cognition/src/pper/plan-builder.js';
import { OpenAICompatibleLLMClient } from '../packages/cognition/src/llm/openai-client.js';

const planter: Affordance[] = [
  {
    id: 'plant_seeds',
    label: 'Plant seeds (after 3 plantings, vegetables ripen for harvest)',
    engineEffect: 'plant_seeds',
    preconditions: [],
    effects: { curiosity: 12, comfort: 4 },
    objectId: 'planter-1',
    objectName: 'Planter',
  },
  {
    id: 'harvest',
    label: 'Harvest vegetables (requires 3 seeds planted)',
    engineEffect: 'harvest',
    preconditions: [],
    effects: { curiosity: 10, comfort: 5 },
    objectId: 'planter-1',
    objectName: 'Planter',
  },
  {
    id: 'eat',
    label: 'Eat a vegetable',
    engineEffect: 'eat',
    preconditions: [],
    effects: { hunger: 25 },
    objectId: 'planter-1',
    objectName: 'Planter',
  },
];

const personas: Record<string, import('../packages/shared/src/index.js').AgentProfile> = {
  tomas: {
    id: 'apprentice-1',
    name: 'Tomas Lind',
    description: 'Apprentice gardener',
    traits: ['curious', 'energetic'],
    backstory:
      'Tomas spent three years sanding chair legs before realizing he wanted to grow ' +
      'what he built with. He asked Maren for work until she said yes. He trusts his ' +
      'hands more than his words and learns by doing, not by asking twice.',
    longTermGoals: [
      'Grow something from seed to table entirely on his own',
      "Earn Maren's full trust",
    ],
    startRoomId: 'garden',
  },
  maren: {
    id: 'gardener-1',
    name: 'Maren Holt',
    description: 'Gardener',
    traits: ['patient', 'practical'],
    backstory:
      'Maren has kept the community garden alive for a decade. She plants, waters, ' +
      'and harvests with the same steady rhythm she uses to keep her ledgers.',
    longTermGoals: ['Keep the garden thriving', 'Teach Tomas the craft'],
    startRoomId: 'garden',
  },
};

interface Variant {
  name: string;
  persona: 'tomas' | 'maren';
  drives: Record<string, number>;
  feedback?: string;
  agentsPresent?: boolean;
}

const variants: Variant[] = [
  {
    name: 'tomas+zero+feedback+AGENTS',
    persona: 'tomas',
    drives: { energy: 0, hunger: 0, social: 0, comfort: 0, curiosity: 0 },
    feedback: 'The planter is full.',
    agentsPresent: true,
  },
  {
    name: 'tomas+zero-drives+feedback',
    persona: 'tomas',
    drives: { energy: 0, hunger: 0, social: 0, comfort: 0, curiosity: 0 },
    feedback: 'The planter is full.',
  },
  {
    name: 'tomas+mid-drives+nofeedback',
    persona: 'tomas',
    drives: { energy: 45, hunger: 40, social: 60, comfort: 50, curiosity: 60 },
  },
  {
    name: 'maren+mid-drives+feedback',
    persona: 'maren',
    drives: { energy: 45, hunger: 40, social: 60, comfort: 50, curiosity: 60 },
    feedback: 'The planter is full.',
  },
  {
    name: 'tomas+mid-drives+feedback',
    persona: 'tomas',
    drives: { energy: 45, hunger: 40, social: 60, comfort: 50, curiosity: 60 },
    feedback: 'The planter is full.',
  },
];

const N = 6;
const model = process.env['LLM_MODEL'] ?? 'gemma4:31b-cloud';
const client = new OpenAICompatibleLLMClient({
  baseUrl: 'http://localhost:11434/v1',
  model,
  maxConcurrentRequests: 1,
});

const builder = new PlanBuilderImpl();

for (const v of variants) {
  let empty = 0;
  let ok = 0;
  const perAttempt: string[] = [];
  for (let i = 0; i < N; i++) {
    const perception = {
      passive: {
        roomId: 'garden',
        objectsPresent: [{ objectId: 'planter-1', name: 'Planter', type: 'furniture' }],
        drives: v.drives,
        ...(v.feedback !== undefined ? { systemFeedback: v.feedback } : {}),
        ...(v.agentsPresent
          ? {
              agentsPresent: [
                { agentId: 'gardener-1', name: 'Maren Holt', currentActivity: 'farming' },
              ],
            }
          : {}),
      },
      prunedAffordances: planter,
      primaryDriveLabel: 'restore energy and hunger',
    } as unknown as PerceptionResult;

    const payload = builder.build(perception);
    payload.agentId = `repro-${v.persona}`;
    try {
      const result = await client.completePlan(payload);
      ok += 1;
      perAttempt.push(`ok(${result.steps.length} steps)`);
    } catch (err) {
      empty += 1;
      perAttempt.push(err instanceof Error ? err.message.slice(0, 60) : 'err');
    }
  }
  console.log(`${v.name}: ok=${ok}/${N} empty=${empty} [${perAttempt.join(' | ')}]`);
}
void model;
