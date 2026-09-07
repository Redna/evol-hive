/**
 * Multi-turn tool-loop empty-args repro: emulate the live pattern —
 * turn 1: model calls observe_agent; append the tool result;
 * turn 2: model should now call formulate_plan. Watch for args:{} on turn 2.
 */
const MODEL = process.env['LLM_MODEL'] ?? 'gemma4:31b-cloud';
const URL = 'http://localhost:11434/v1/chat/completions';

const SYSTEM =
  'You are Tomas Lind, Apprentice gardener — a former furniture-maker who left the workshop bench to learn how things grow. He asked Maren for work until she said yes. ' +
  'You must formulate a plan to satisfy your most urgent drive. ' +
  'Use the formulate_plan cognitive tool to break your goal into a sequence of actionable steps. ' +
  'EVERY step in your plan MUST set targetAffordance to one of the enum values in the formulate_plan tool schema (the affordances available to you right now). Use "wait" when no affordance is relevant.';

const CONTEXT =
  `Room: garden. Objects present: Planter (furniture), Toolbox (tool), Gate (doorway), Garden Bench (furniture), Doorway (doorway). ` +
  `Agents present: Maren Holt (farming). You can call talk_to, observe_agent, help, or ignore directly to interact with them. ` +
  `--- Primary drive: All drives critically low — agent is in crisis state. Drives: energy=0, hunger=0, social=0, comfort=0, curiosity=0. ` +
  `System feedback: The planter is full. IMPORTANT: Do NOT plan an action that just failed. Choose a DIFFERENT affordance.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'observe_agent',
      description: 'Observe another agent',
      parameters: {
        type: 'object',
        properties: { targetAgentId: { type: 'string' } },
        required: ['targetAgentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'formulate_plan',
      description:
        "Create a plan to satisfy the agent's drives. EVERY step MUST set targetAffordance to one of the enum values (use 'wait' when nothing is relevant).",
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'High-level description of the plan.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                targetAffordance: {
                  type: 'string',
                  description:
                    "The affordance ID to execute for this step. MUST be one of the enum values. Use 'wait' when no affordance is relevant.",
                  enum: ['plant_seeds', 'harvest', 'eat', 'observe', 'wait'],
                },
              },
              required: ['description'],
              additionalProperties: false,
            },
          },
        },
        required: ['description', 'steps'],
        additionalProperties: false,
      },
    },
  },
];

const messages: unknown[] = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: CONTEXT + '\n\nYou see Maren Holt farming nearby. What do you do?' },
];

async function turn(): Promise<{ tool: string; args: string }> {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto' }),
  });
  if (!res.ok) {
    console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const d = (await res.json()) as {
    choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
  };
  const tc = d.choices[0]!.message.tool_calls?.[0];
  return { tool: tc?.function.name ?? '(none)', args: tc?.function.arguments ?? '(no args)' };
}

// Turn 1: force the observe path by making social salient.
messages.push({ role: 'user', content: 'Observe Maren Holt first.' });
let t1 = await turn();
console.log(`turn1: ${t1.tool} args=${t1.args.slice(0, 60)}`);

// Append a realistic observe_agent tool result (the target agent's full state).
messages.push({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: 'c1',
      type: 'function',
      function: { name: t1.tool, arguments: '{"targetAgentId":"gardener-1"}' },
    },
  ],
});
messages.push({
  role: 'tool',
  content: JSON.stringify({
    agentId: 'gardener-1',
    name: 'Maren Holt',
    drives: { energy: 99, hunger: 98, social: 70, comfort: 90, curiosity: 95 },
    currentPlan: {
      description: 'Farm',
      steps: [{ description: 'Plant seeds', targetAffordance: 'plant_seeds' }],
    },
    location: 'garden',
  }),
  tool_call_id: 'c1',
});

// Turn 2: this is where the live run sees args:{} — sample it 5 times.
for (let i = 0; i < 5; i++) {
  messages.pop();
  messages.pop(); // re-push fresh each time
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `c${i}t2`,
        type: 'function',
        function: { name: t1.tool, arguments: '{"targetAgentId":"gardener-1"}' },
      },
    ],
  });
  messages.push({
    role: 'tool',
    content: JSON.stringify({
      agentId: 'gardener-1',
      name: 'Maren Holt',
      drives: { energy: 99, hunger: 98 },
      location: 'garden',
    }),
    tool_call_id: `c${i}t2`,
  });
  const t2 = await turn();
  const flag =
    t2.tool === 'formulate_plan' && (t2.args === '{}' || t2.args === '')
      ? ' *** EMPTY ARGS ***'
      : '';
  console.log(`turn2.${i}: ${t2.tool} args=${t2.args.slice(0, 80)}${flag}`);
}
