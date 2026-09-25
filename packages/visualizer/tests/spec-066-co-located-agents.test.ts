/**
 * Spec 066 — leg 2: co-located agents are separately placed, and what is drawn
 * is what is selected.
 * ==================================================================
 * AC-1, AC-2 (D1). The shipped defect: `layoutWorld` placed every agent at its
 * raw cell centre, so agents sharing a cell received **identical** coordinates.
 * The renderer paints in order (last on top) while `hitTestAgent` returns the
 * **first** agent within its tap radius, so the two consumers disagreed —
 * measured live, a probe at the drawn chip returned `agent-alice` where the chip
 * was labelled **"Carol"**. Tapping the agent you can see opened a different
 * agent's card.
 *
 * Why uniqueness is the right thing to assert: it is the invariant that makes
 * both consumers agree *by construction*. Positions live in the layout, and the
 * renderer and the hit test both read the layout, so no test needs to re-derive
 * anyone's screen position to prove the tap lands on the right agent.
 *
 * Determinism here is stronger than "same input, same output": the slot a given
 * agent receives must not depend on the *order* of `state.agents`, because that
 * order is a transport detail. Two runs that agree only because the array
 * happened to be ordered the same way would still tear if it ever changed.
 */
import { describe, it, expect } from 'vitest';
import type { VisualizerAgent, VisualizerRoom, VisualizerState } from '@evol-hive/shared';
import { cellCenter, layoutWorld, ZERO_INSETS } from '../src/renderer/layout.js';
import type { Viewport } from '../src/renderer/layout.js';

function rooms(): VisualizerRoom[] {
  return [
    { id: 'kitchen', name: 'Kitchen', description: '', connections: ['garden'], objects: [] },
    { id: 'garden', name: 'Garden', description: '', connections: ['kitchen'], objects: [] },
  ];
}

function agent(agentId: string, position: { x: number; y: number }): VisualizerAgent {
  return {
    agentId,
    name: agentId,
    location: 'kitchen',
    position,
    drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
    currentGoal: '',
    currentPlan: null,
    pperPhase: 'perceive',
    isThinking: false,
    relationships: [],
  } as unknown as VisualizerAgent;
}

function state(agents: VisualizerAgent[]): VisualizerState {
  return {
    tickNumber: 0,
    simulationTime: 0,
    isRunning: false,
    timeScale: 1,
    rooms: rooms(),
    agents,
  } as unknown as VisualizerState;
}

const VIEWPORT: Viewport = { width: 800, height: 600, insets: ZERO_INSETS };
const CELL = { x: 3, y: 3 };

const positions = (s: VisualizerState): Map<string, { x: number; y: number }> =>
  new Map(layoutWorld(s, VIEWPORT).agents.map((a) => [a.id, { x: a.x, y: a.y }]));

describe('spec 066 — co-located agents are separately placed (AC-1, AC-2)', () => {
  it('gives two agents in the same cell distinct positions', () => {
    const s = state([agent('alice', CELL), agent('bob', CELL)]);
    const [a, b] = [...positions(s).values()];
    expect([a!.x, a!.y]).not.toEqual([b!.x, b!.y]);
  });

  it('spreads three co-located agents to three distinct positions', () => {
    const s = state([agent('alice', CELL), agent('bob', CELL), agent('carol', CELL)]);
    const seen = new Set([...positions(s).values()].map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(3);
  });

  it('keeps an agent in another cell clear of a co-located pair', () => {
    const s = state([
      agent('alice', CELL),
      agent('bob', CELL),
      agent('carol', { x: CELL.x + 1, y: CELL.y }),
    ]);
    const at = positions(s);
    const pair = [at.get('alice')!, at.get('bob')!];
    const other = at.get('carol')!;
    for (const p of pair) {
      expect([other.x, other.y]).not.toEqual([p.x, p.y]);
    }
  });

  it('assigns the same slot regardless of the order of state.agents', () => {
    const forward = state([agent('alice', CELL), agent('bob', CELL)]);
    const reversed = state([agent('bob', CELL), agent('alice', CELL)]);
    expect(positions(reversed).get('alice')).toEqual(positions(forward).get('alice'));
    expect(positions(reversed).get('bob')).toEqual(positions(forward).get('bob'));
    // And guard against a vacuous pass: the two agents are genuinely apart, so
    // "same position for alice" is not just "they share one point".
    expect(positions(forward).get('alice')).not.toEqual(positions(forward).get('bob'));
  });

  it('leaves a lone agent exactly at its cell centre (no common-case regression)', () => {
    const s = state([agent('alice', CELL)]);
    const room = layoutWorld(s, VIEWPORT).rooms.find((r) => r.roomId === 'kitchen')!;
    expect(positions(s).get('alice')).toEqual(cellCenter(room.rect, CELL));
  });
});
