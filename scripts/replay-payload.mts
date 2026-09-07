const dump = process.argv[2] ?? '/tmp/empty-args-<agentId>.json'; // dumped by [llm-raw] on first occurrence per agent
import { readFileSync } from 'node:fs';
const d = JSON.parse(readFileSync(dump, 'utf-8'));
const URL = 'http://localhost:11434/v1/chat/completions';
const MODEL = process.env['LLM_MODEL'] ?? 'gemma4:31b-cloud';

async function send(
  messages: unknown[],
  tools: unknown[],
): Promise<{ tool: string; args: string; status: number }> {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto' }),
  });
  if (!res.ok) return { tool: 'HTTP', args: String(res.status), status: res.status };
  const j = (await res.json()) as {
    choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
  };
  const tc = j.choices[0]!.message.tool_calls?.[0];
  return {
    tool: tc?.function.name ?? '(none)',
    args: tc?.function.arguments ?? '(none)',
    status: 200,
  };
}

console.log('=== replay 3x with FULL original payload ===');
for (let i = 0; i < 3; i++) {
  const r = await send(d.messages, d.tools);
  const bad = r.tool === 'formulate_plan' && (r.args === '{}' || r.args === '');
  console.log(`#${i}: ${r.tool} ${bad ? '*** EMPTY ***' : r.args.slice(0, 70)}`);
}
console.log('=== bisect: drop the LAST message (usually the tool/user turn) ===');
if (d.messages.length > 2) {
  for (let cut = 1; cut <= 3; cut++) {
    const trimmed = d.messages.slice(0, d.messages.length - cut);
    const r = await send(trimmed, d.tools);
    const bad = r.tool === 'formulate_plan' && (r.args === '{}' || r.args === '');
    console.log(`cut ${cut}: ${r.tool} ${bad ? '*** EMPTY ***' : r.args.slice(0, 70)}`);
  }
}
console.log('=== bisect: original tools vs minimal tools ===');
const rTools = await send(d.messages, [d.tools[0]]);
const bad2 = rTools.tool === 'formulate_plan' && (rTools.args === '{}' || rTools.args === '');
console.log(`first-tool-only: ${rTools.tool} ${bad2 ? '*** EMPTY ***' : rTools.args.slice(0, 70)}`);
