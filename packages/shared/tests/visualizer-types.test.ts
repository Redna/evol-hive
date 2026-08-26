/**
 * Spec 023 — Visual Output Canvas Renderer
 * Shared layer visualizer types (AC-1).
 *
 * Verifies that `VisualizerState` and all sub-types are defined, exported from
 * the package index, and JSON-serializable (all fields are plain JSON-compatible
 * primitives, arrays, or plain objects).
 */
import { describe, it, expect } from 'vitest';
// Runtime side-effect import forces resolution of the module file so the test
// fails when the types module does not exist yet.
import '../src/types/visualizer.js';
import type {
  VisualizerState,
  VisualizerRoom,
  VisualizerObject,
  VisualizerAgent,
  VisualizerCommand,
  VisualizerInterface,
} from '../src/index.js';
import type { AgentDrives, PPERPhase } from '../src/index.js';

describe('Visualizer shared types (AC-1)', () => {
  it('VisualizerState is constructible with all required fields', () => {
    const state: VisualizerState = {
      tickNumber: 42,
      simulationTime: 3.5,
      isRunning: true,
      timeScale: 2,
      rooms: [],
      agents: [],
    };
    expect(state.tickNumber).toBe(42);
    expect(state.simulationTime).toBe(3.5);
    expect(state.isRunning).toBe(true);
    expect(state.timeScale).toBe(2);
    expect(state.rooms).toEqual([]);
    expect(state.agents).toEqual([]);
  });

  it('VisualizerState is fully JSON-serializable (round-trip)', () => {
    const drives: AgentDrives = {
      energy: 30,
      hunger: 60,
      social: 80,
      comfort: 50,
      curiosity: 90,
    };
    const state: VisualizerState = {
      tickNumber: 7,
      simulationTime: 1.25,
      isRunning: false,
      timeScale: 5,
      rooms: [
        {
          id: 'kitchen',
          name: 'Kitchen',
          description: 'A small kitchen.',
          connections: ['living'],
          objects: [
            {
              id: 'coffee-1',
              name: 'Coffee Machine',
              type: 'appliance',
              state: { water_level: 5, bean_count: 12 },
              affordances: [{ id: 'brew_coffee', label: 'Brew coffee' }],
              compoundActions: [{ id: 'brew', label: 'Brew', stepCount: 3 }],
            },
          ],
        },
      ],
      agents: [
        {
          agentId: 'agent-1',
          name: 'Alice',
          location: 'kitchen',
          drives,
          currentGoal: 'Get coffee',
          currentPlan: {
            description: 'Brew and drink coffee',
            currentStepIndex: 1,
            totalSteps: 3,
          },
          pperPhase: 'plan',
          isThinking: true,
          relationships: [{ agentId: 'agent-2', trust: 70, familiarity: 40 }],
        },
      ],
    };

    const json = JSON.stringify(state);
    const parsed = JSON.parse(json) as VisualizerState;

    expect(parsed.tickNumber).toBe(7);
    expect(parsed.isRunning).toBe(false);
    expect(parsed.timeScale).toBe(5);
    expect(parsed.rooms).toHaveLength(1);
    expect(parsed.rooms[0]!.objects[0]!.state['water_level']).toBe(5);
    expect(parsed.agents[0]!.name).toBe('Alice');
    expect(parsed.agents[0]!.drives.energy).toBe(30);
    expect(parsed.agents[0]!.currentPlan?.totalSteps).toBe(3);
    expect(parsed.agents[0]!.relationships[0]!.trust).toBe(70);
  });

  it('VisualizerRoom carries flattened object list', () => {
    const room: VisualizerRoom = {
      id: 'living',
      name: 'Living Room',
      description: 'Cozy.',
      connections: ['kitchen', 'hall'],
      objects: [],
    };
    expect(room.connections).toEqual(['kitchen', 'hall']);
    expect(room.objects).toEqual([]);
  });

  it('VisualizerObject supports optional compoundActions', () => {
    const obj: VisualizerObject = {
      id: 'o1',
      name: 'Sofa',
      type: 'furniture',
      state: { cushion_count: 3 },
      affordances: [{ id: 'sit', label: 'Sit down' }],
    };
    expect(obj.compoundActions).toBeUndefined();
    const obj2: VisualizerObject = {
      ...obj,
      compoundActions: [{ id: 'relax', label: 'Relax', stepCount: 2 }],
    };
    expect(obj2.compoundActions?.[0]?.stepCount).toBe(2);
  });

  it('VisualizerAgent currentPlan is nullable', () => {
    const drives: AgentDrives = {
      energy: 50,
      hunger: 50,
      social: 50,
      comfort: 50,
      curiosity: 50,
    };
    const agent: VisualizerAgent = {
      agentId: 'a1',
      name: 'Bob',
      location: 'kitchen',
      drives,
      currentGoal: '',
      currentPlan: null,
      pperPhase: 'perceive' as PPERPhase,
      isThinking: false,
      relationships: [],
    };
    expect(agent.currentPlan).toBeNull();
  });

  it('VisualizerCommand discriminated union covers all variants', () => {
    const cmds: VisualizerCommand[] = [
      { type: 'play' },
      { type: 'pause' },
      { type: 'setSpeed', timeScale: 2 },
      { type: 'save' },
      { type: 'load', stateJson: '{}' },
      { type: 'selectScene', sceneId: 'minimal' },
    ];
    expect(cmds).toHaveLength(6);
    const json = JSON.stringify(cmds);
    const parsed = JSON.parse(json) as VisualizerCommand[];
    expect(parsed[0]).toEqual({ type: 'play' });
    expect(parsed[2]).toEqual({ type: 'setSpeed', timeScale: 2 });
    expect(parsed[5]).toEqual({ type: 'selectScene', sceneId: 'minimal' });
  });

  it('VisualizerInterface declares getSnapshot and handleCommand', () => {
    const iface: VisualizerInterface = {
      getSnapshot: () => ({
        tickNumber: 0,
        simulationTime: 0,
        isRunning: false,
        timeScale: 1,
        rooms: [],
        agents: [],
      }),
      handleCommand: async () => {},
    };
    expect(typeof iface.getSnapshot).toBe('function');
    expect(typeof iface.handleCommand).toBe('function');
    const snap = iface.getSnapshot();
    expect(snap.tickNumber).toBe(0);
  });
});
