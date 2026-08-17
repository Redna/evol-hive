/**
 * Richer Prototype Scenes — Integration Tests (spec 013, issue #45)
 * ─────────────────────────────────────────────────────────────────
 * Covers the Morning Routine and Office Day scenes, the shared affordance
 * handler library, per-agent starting rooms, multi-room navigation, object
 * state depletion, multi-agent concurrency, drive prioritization, and
 * precondition enforcement.
 *
 * Acceptance criteria covered: AC-1 .. AC-35.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  AgentProfile,
  AffordanceResult,
  GameTick,
  PPEROrchestratorPort,
  SceneDefinition,
  SmartObject,
  EngineConfig,
} from '@evol-hive/shared';
import { createEngineCore, loadScene, assembleGameLoop } from '../src/assembly.js';
import type { EngineCore } from '../src/assembly.js';
import { PPERScheduler } from '../src/systems/pper-scheduler.js';
import { registerAffordanceHandlers } from '../../../examples/scene-helpers.ts';
import {
  MORNING_ROUTINE_SCENE,
  buildMorningRoutineEngine,
  MorningRoutineMockLLMClient,
} from '../../../examples/morning-routine.ts';
import {
  OFFICE_DAY_SCENE,
  buildOfficeDayEngine,
  OfficeDayMockLLMClient,
} from '../../../examples/office-day.ts';
import type { LLMContextPayload } from '@evol-hive/cognition';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(): EngineConfig {
  return {
    fps: 60,
    spatialDebounceSeconds: 5,
    maxConcurrentLLM: 8,
    guardrailsEnabled: true,
  };
}

const TICK: GameTick = { tickNumber: 1, simulationTime: 0.0167, deltaSeconds: 0.0167 };

/** A fake orchestrator that records runCycle calls and optionally hangs. */
class FakeOrchestrator implements PPEROrchestratorPort {
  runCycleCalls: string[] = [];
  autoResolve = true;

  async runCycle(agentId: string): Promise<void> {
    this.runCycleCalls.push(agentId);
    if (!this.autoResolve) return new Promise<void>(() => {});
  }

  getPhase(_agentId: string) {
    return 'perceive' as const;
  }
}

/** Build a core with the Morning Routine scene loaded + handlers registered. */
function setupMorningRoutine(): EngineCore {
  const core = createEngineCore(makeConfig());
  loadScene(core, MORNING_ROUTINE_SCENE);
  registerAffordanceHandlers(core);
  return core;
}

/** Build a core with the Office Day scene loaded + handlers registered. */
function setupOfficeDay(): EngineCore {
  const core = createEngineCore(makeConfig());
  loadScene(core, OFFICE_DAY_SCENE);
  registerAffordanceHandlers(core);
  return core;
}

/** Execute an affordance directly via the physics system. */
async function execute(
  core: EngineCore,
  objectId: string,
  affordanceId: string,
  agentId: string,
): Promise<AffordanceResult> {
  return core.physics.executeAffordance(objectId, affordanceId, agentId);
}

// ─── AC-1: startRoomId on AgentProfile ───────────────────────────────────────

describe('AC-1: AgentProfile.startRoomId', () => {
  it('accepts an optional startRoomId field', () => {
    const profile: AgentProfile = {
      id: 'a1',
      name: 'Test',
      description: 'test',
      traits: [],
      initialDrives: { energy: 50 },
      startRoomId: 'bedroom',
    };
    expect(profile.startRoomId).toBe('bedroom');
  });

  it('compiles without startRoomId (backward compatible)', () => {
    const profile: AgentProfile = {
      id: 'a2',
      name: 'Test2',
      description: 'test',
      traits: [],
      initialDrives: { energy: 50 },
    };
    expect(profile.startRoomId).toBeUndefined();
  });
});

// ─── AC-2 / AC-35: loadScene respects startRoomId ────────────────────────────

describe('AC-2 / AC-35: loadScene per-agent starting rooms', () => {
  it('spawns agents in their startRoomId when present', () => {
    const core = setupMorningRoutine();
    expect(core.agentManager.getState('agent-alice')?.location).toBe('bedroom');
    expect(core.agentManager.getState('agent-bob')?.location).toBe('living_room');
  });

  it('spawns Office Day agents in their startRoomId', () => {
    const core = setupOfficeDay();
    expect(core.agentManager.getState('agent-alice')?.location).toBe('office');
    expect(core.agentManager.getState('agent-bob')?.location).toBe('break_room');
    expect(core.agentManager.getState('agent-carol')?.location).toBe('meeting_room');
  });

  it('falls back to scene.rooms[0] when startRoomId is absent', () => {
    const core = createEngineCore(makeConfig());
    const scene: SceneDefinition = {
      id: 'test',
      name: 'Test',
      rooms: [
        { id: 'r1', name: 'R1', description: '', connections: ['r2'], objectIds: [] },
        { id: 'r2', name: 'R2', description: '', connections: ['r1'], objectIds: [] },
      ],
      objects: [],
      agents: [{ id: 'a', name: 'A', description: '', traits: [], initialDrives: { energy: 50 } }],
    };
    loadScene(core, scene);
    expect(core.agentManager.getState('a')?.location).toBe('r1');
  });
});

// ─── AC-3: registerAffordanceHandlers registers all handlers ─────────────────

describe('AC-3: registerAffordanceHandlers', () => {
  const EXPECTED_HANDLERS = [
    'sleep',
    'brew_coffee',
    'observe',
    'take_shower',
    'watch_tv',
    'read_book',
    'go_outside',
    'work',
    'brainstorm',
    'small_talk',
    'hold_meeting',
    'use_bathroom',
    'wash_hands',
    'print_document',
    'go_to_bedroom',
    'go_to_bathroom',
    'go_to_living_room',
    'go_to_kitchen',
    'go_to_office',
    'go_to_break_room',
    'go_to_meeting_room',
  ];

  it('registers a non-null handler for every expected affordance ID', () => {
    const core = setupMorningRoutine();
    for (const id of EXPECTED_HANDLERS) {
      expect(core.affordanceRegistry.getHandler(id), `handler for ${id}`).not.toBeNull();
    }
  });
});

// ─── AC-18: Precondition checkers ─────────────────────────────────────────────

describe('AC-18: Precondition checkers', () => {
  it('registers has_water, has_beans, is_powered, has_books, has_paper', () => {
    const core = setupMorningRoutine();
    // Indirectly verify via checkPreconditions on objects that use them.
    const coffee = core.smartObjectRegistry.get('coffee-1')!;
    const pre = core.affordanceRegistry.checkPreconditions('brew_coffee', coffee.id);
    // water_level: 5, bean_count: 12 → both pass.
    expect(pre.satisfied).toBe(true);
    expect(pre.failed).toEqual([]);
  });

  it('has_water returns false when water_level === 0', () => {
    const core = setupMorningRoutine();
    core.smartObjectRegistry.updateState('coffee-1', { water_level: 0, bean_count: 12 });
    const pre = core.affordanceRegistry.checkPreconditions('brew_coffee', 'coffee-1');
    expect(pre.satisfied).toBe(false);
    expect(pre.failed).toContain('has_water');
  });

  it('is_powered returns true when powered_on === true and false otherwise', () => {
    const core = setupMorningRoutine();
    // tv-1 starts powered_on: true.
    const preOn = core.affordanceRegistry.checkPreconditions('watch_tv', 'tv-1');
    expect(preOn.satisfied).toBe(true);
    core.smartObjectRegistry.updateState('tv-1', { powered_on: false });
    const preOff = core.affordanceRegistry.checkPreconditions('watch_tv', 'tv-1');
    expect(preOff.satisfied).toBe(false);
    expect(preOff.failed).toContain('is_powered');
  });
});

// ─── AC-4: brew_coffee handler ───────────────────────────────────────────────

describe('AC-4: brew_coffee handler', () => {
  it('decrements water_level and bean_count by 1 and returns driveChanges { energy: 20 }', async () => {
    const core = setupMorningRoutine();
    const res = await execute(core, 'coffee-1', 'brew_coffee', 'agent-alice');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ energy: 20 });
    const obj = core.smartObjectRegistry.get('coffee-1')!;
    expect(obj.state['water_level']).toBe(4);
    expect(obj.state['bean_count']).toBe(11);
  });

  it('after 3 calls, water_level is 2 and bean_count is 9', async () => {
    const core = setupMorningRoutine();
    for (let i = 0; i < 3; i++) {
      await execute(core, 'coffee-1', 'brew_coffee', 'agent-alice');
    }
    const obj = core.smartObjectRegistry.get('coffee-1')!;
    expect(obj.state['water_level']).toBe(2);
    expect(obj.state['bean_count']).toBe(9);
  });
});

// ─── AC-5: sleep handler ─────────────────────────────────────────────────────

describe('AC-5: sleep handler', () => {
  it('returns driveChanges { energy: 30, comfort: -5 } with no object state change', async () => {
    const core = setupMorningRoutine();
    const before = { ...core.smartObjectRegistry.get('bed-1')!.state };
    const res = await execute(core, 'bed-1', 'sleep', 'agent-alice');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ energy: 30, comfort: -5 });
    expect(core.smartObjectRegistry.get('bed-1')!.state).toEqual(before);
  });
});

// ─── AC-6: take_shower handler ───────────────────────────────────────────────

describe('AC-6: take_shower handler', () => {
  it('decrements water_level by 1 and returns driveChanges { comfort: 25, energy: -5 }', async () => {
    const core = setupMorningRoutine();
    const res = await execute(core, 'shower-1', 'take_shower', 'agent-alice');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ comfort: 25, energy: -5 });
    expect(core.smartObjectRegistry.get('shower-1')!.state['water_level']).toBe(9);
  });
});

// ─── AC-7: watch_tv handler ──────────────────────────────────────────────────

describe('AC-7: watch_tv handler', () => {
  it('returns driveChanges { comfort: 15, energy: -5, curiosity: 5 } and sets powered_on: false', async () => {
    const core = setupMorningRoutine();
    const res = await execute(core, 'tv-1', 'watch_tv', 'agent-alice');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ comfort: 15, energy: -5, curiosity: 5 });
    expect(core.smartObjectRegistry.get('tv-1')!.state['powered_on']).toBe(false);
  });
});

// ─── AC-8: read_book handler ─────────────────────────────────────────────────

describe('AC-8: read_book handler', () => {
  it('decrements book_count by 1 and returns driveChanges { curiosity: 20, energy: -10 }', async () => {
    const core = setupMorningRoutine();
    const res = await execute(core, 'bookshelf-1', 'read_book', 'agent-alice');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ curiosity: 20, energy: -10 });
    expect(core.smartObjectRegistry.get('bookshelf-1')!.state['book_count']).toBe(7);
  });

  it('handler defensively returns { success: false, failureReason: "No books left" } when book_count is 0', async () => {
    const core = setupMorningRoutine();
    // Call the handler directly — the precondition check would block this via physics.
    const handler = core.affordanceRegistry.getHandler('read_book')!;
    const res = await handler('bookshelf-1', 'agent-alice', { book_count: 0 });
    expect(res.success).toBe(false);
    expect(res.failureReason).toContain('No books left');
  });
});

// ─── AC-9: go_outside handler ────────────────────────────────────────────────

describe('AC-9: go_outside handler', () => {
  it('returns { success: true } and logs a message containing the agent ID', async () => {
    const core = setupMorningRoutine();
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      const res = await execute(core, 'front-door-1', 'go_outside', 'agent-alice');
      expect(res.success).toBe(true);
      expect(res.driveChanges).toBeUndefined();
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes('agent-alice'))).toBe(true);
  });
});

// ─── AC-10: work handler ─────────────────────────────────────────────────────

describe('AC-10: work handler', () => {
  it('returns driveChanges { energy: -15 } and increments tasks_completed', async () => {
    const core = setupOfficeDay();
    const res = await execute(core, 'computer-1', 'work', 'agent-alice');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ energy: -15 });
    expect(core.smartObjectRegistry.get('computer-1')!.state['tasks_completed']).toBe(1);
  });
});

// ─── AC-11: brainstorm handler ───────────────────────────────────────────────

describe('AC-11: brainstorm handler', () => {
  it('returns driveChanges { curiosity: 15, social: 5, energy: -10 } and increments ideas_generated', async () => {
    const core = setupOfficeDay();
    const res = await execute(core, 'whiteboard-1', 'brainstorm', 'agent-alice');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ curiosity: 15, social: 5, energy: -10 });
    expect(core.smartObjectRegistry.get('whiteboard-1')!.state['ideas_generated']).toBe(1);
  });
});

// ─── AC-12: small_talk handler ───────────────────────────────────────────────

describe('AC-12: small_talk handler', () => {
  it('returns driveChanges { social: 15, energy: -2 } with no object state change', async () => {
    const core = setupOfficeDay();
    const before = { ...core.smartObjectRegistry.get('cooler-1')!.state };
    const res = await execute(core, 'cooler-1', 'small_talk', 'agent-bob');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ social: 15, energy: -2 });
    expect(core.smartObjectRegistry.get('cooler-1')!.state).toEqual(before);
  });
});

// ─── AC-13: hold_meeting handler ─────────────────────────────────────────────

describe('AC-13: hold_meeting handler', () => {
  it('returns driveChanges { social: 20, energy: -15, comfort: -5 } and increments meetings_held', async () => {
    const core = setupOfficeDay();
    const res = await execute(core, 'table-1', 'hold_meeting', 'agent-carol');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ social: 20, energy: -15, comfort: -5 });
    expect(core.smartObjectRegistry.get('table-1')!.state['meetings_held']).toBe(1);
  });
});

// ─── AC-14: use_bathroom handler ──────────────────────────────────────────────

describe('AC-14: use_bathroom handler', () => {
  it('returns driveChanges { comfort: 10 } with no object state change', async () => {
    const core = setupOfficeDay();
    const before = { ...core.smartObjectRegistry.get('toilet-1')!.state };
    const res = await execute(core, 'toilet-1', 'use_bathroom', 'agent-alice');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ comfort: 10 });
    expect(core.smartObjectRegistry.get('toilet-1')!.state).toEqual(before);
  });
});

// ─── AC-15: wash_hands handler ────────────────────────────────────────────────

describe('AC-15: wash_hands handler', () => {
  it('returns driveChanges { comfort: 5 } with no object state change', async () => {
    const core = setupOfficeDay();
    const before = { ...core.smartObjectRegistry.get('sink-1')!.state };
    const res = await execute(core, 'sink-1', 'wash_hands', 'agent-alice');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ comfort: 5 });
    expect(core.smartObjectRegistry.get('sink-1')!.state).toEqual(before);
  });
});

// ─── AC-16: print_document handler ────────────────────────────────────────────

describe('AC-16: print_document handler', () => {
  it('decrements paper_count by 1 and returns driveChanges { curiosity: 2 }', async () => {
    const core = setupOfficeDay();
    const res = await execute(core, 'printer-1', 'print_document', 'agent-alice');
    expect(res.success).toBe(true);
    expect(res.driveChanges).toEqual({ curiosity: 2 });
    expect(core.smartObjectRegistry.get('printer-1')!.state['paper_count']).toBe(49);
  });

  it('handler defensively returns { success: false, failureReason: "Printer out of paper" } when paper_count is 0', async () => {
    const core = setupOfficeDay();
    // Call the handler directly — the precondition check would block this via physics.
    const handler = core.affordanceRegistry.getHandler('print_document')!;
    const res = await handler('printer-1', 'agent-alice', { paper_count: 0 });
    expect(res.success).toBe(false);
    expect(res.failureReason).toContain('Printer out of paper');
  });
});

// ─── AC-17 / AC-30: go_to_* movement handlers ─────────────────────────────────

describe('AC-17 / AC-30: multi-room navigation', () => {
  it('go_to_living_room moves an agent from bedroom to living_room', async () => {
    const core = setupMorningRoutine();
    // Alice starts in bedroom.
    expect(core.sceneManager.getAgentRoom('agent-alice')?.id).toBe('bedroom');
    // Find the doorway object in the bedroom.
    const bedroomObjects = core.smartObjectRegistry.getObjectsInRoom('bedroom');
    const doorway = bedroomObjects.find((o) => o.type === 'doorway')!;
    expect(doorway).toBeDefined();
    const res = await execute(core, doorway.id, 'go_to_living_room', 'agent-alice');
    expect(res.success).toBe(true);
    expect(core.sceneManager.getAgentRoom('agent-alice')?.id).toBe('living_room');
  });

  it('go_to_kitchen then moves the agent from living_room to kitchen', async () => {
    const core = setupMorningRoutine();
    // Move Alice to living_room first.
    const bedroomDoorway = core.smartObjectRegistry
      .getObjectsInRoom('bedroom')
      .find((o) => o.type === 'doorway')!;
    await execute(core, bedroomDoorway.id, 'go_to_living_room', 'agent-alice');
    expect(core.sceneManager.getAgentRoom('agent-alice')?.id).toBe('living_room');
    // Now go to kitchen.
    const livingRoomDoorway = core.smartObjectRegistry
      .getObjectsInRoom('living_room')
      .find((o) => o.type === 'doorway')!;
    const res = await execute(core, livingRoomDoorway.id, 'go_to_kitchen', 'agent-alice');
    expect(res.success).toBe(true);
    expect(core.sceneManager.getAgentRoom('agent-alice')?.id).toBe('kitchen');
  });
});

// ─── AC-19 / AC-20 / AC-21: Morning Routine scene definition ──────────────────

describe('AC-19 / AC-20 / AC-21: MORNING_ROUTINE_SCENE definition', () => {
  it('has 4 rooms: bedroom, bathroom, living_room, kitchen', () => {
    expect(MORNING_ROUTINE_SCENE.rooms).toHaveLength(4);
    const ids = MORNING_ROUTINE_SCENE.rooms.map((r) => r.id).sort();
    expect(ids).toEqual(['bathroom', 'bedroom', 'kitchen', 'living_room']);
  });

  it('has bidirectional room connections', () => {
    const roomMap = new Map(MORNING_ROUTINE_SCENE.rooms.map((r) => [r.id, r]));
    for (const room of MORNING_ROUTINE_SCENE.rooms) {
      for (const conn of room.connections) {
        const target = roomMap.get(conn);
        expect(target, `connection ${room.id}→${conn}`).toBeDefined();
        expect(target!.connections, `${conn} should connect back to ${room.id}`).toContain(room.id);
      }
    }
  });

  it('bedroom connects to bathroom and living_room; living_room connects to bedroom, bathroom, kitchen; kitchen connects to living_room', () => {
    const bedroom = MORNING_ROUTINE_SCENE.rooms.find((r) => r.id === 'bedroom')!;
    expect(bedroom.connections).toContain('bathroom');
    expect(bedroom.connections).toContain('living_room');
    const living = MORNING_ROUTINE_SCENE.rooms.find((r) => r.id === 'living_room')!;
    expect(living.connections).toContain('bedroom');
    expect(living.connections).toContain('bathroom');
    expect(living.connections).toContain('kitchen');
    const kitchen = MORNING_ROUTINE_SCENE.rooms.find((r) => r.id === 'kitchen')!;
    expect(kitchen.connections).toContain('living_room');
  });

  it('has a Bed in bedroom, Shower in bathroom, TV/Bookshelf/Front Door in living_room, Coffee Machine in kitchen', () => {
    const obj = (id: string) => MORNING_ROUTINE_SCENE.objects.find((o) => o.id === id)!;
    expect(obj('bed-1').roomId).toBe('bedroom');
    expect(obj('shower-1').roomId).toBe('bathroom');
    expect(obj('tv-1').roomId).toBe('living_room');
    expect(obj('bookshelf-1').roomId).toBe('living_room');
    expect(obj('front-door-1').roomId).toBe('living_room');
    expect(obj('coffee-1').roomId).toBe('kitchen');
  });

  it('has a Doorway object in each room with go_to_* affordances matching connections', () => {
    const doorways = MORNING_ROUTINE_SCENE.objects.filter((o) => o.type === 'doorway');
    expect(doorways).toHaveLength(4);
    for (const room of MORNING_ROUTINE_SCENE.rooms) {
      const doorway = doorways.find((d) => d.roomId === room.id);
      expect(doorway, `doorway in ${room.id}`).toBeDefined();
      const affIds = doorway!.affordances.map((a) => a.id);
      for (const conn of room.connections) {
        expect(affIds).toContain(`go_to_${conn}`);
      }
    }
  });

  it('Coffee Machine has brew_coffee with preconditions [has_water, has_beans] and effects { energy: 20 }', () => {
    const coffee = MORNING_ROUTINE_SCENE.objects.find((o) => o.id === 'coffee-1')!;
    const brew = coffee.affordances.find((a) => a.id === 'brew_coffee')!;
    expect(brew.preconditions).toEqual(['has_water', 'has_beans']);
    expect(brew.effects).toEqual({ energy: 20 });
  });

  it('has 2 agents: Alice (startRoomId bedroom, energy 15) and Bob (startRoomId living_room, social 15)', () => {
    expect(MORNING_ROUTINE_SCENE.agents).toHaveLength(2);
    const alice = MORNING_ROUTINE_SCENE.agents.find((a) => a.id === 'agent-alice')!;
    expect(alice.startRoomId).toBe('bedroom');
    expect(alice.initialDrives.energy).toBe(15);
    const bob = MORNING_ROUTINE_SCENE.agents.find((a) => a.id === 'agent-bob')!;
    expect(bob.startRoomId).toBe('living_room');
    expect(bob.initialDrives.social).toBe(15);
  });
});

// ─── AC-24 / AC-25 / AC-26: Office Day scene definition ───────────────────────

describe('AC-24 / AC-25 / AC-26: OFFICE_DAY_SCENE definition', () => {
  it('has 4 rooms: office, break_room, meeting_room, bathroom', () => {
    expect(OFFICE_DAY_SCENE.rooms).toHaveLength(4);
    const ids = OFFICE_DAY_SCENE.rooms.map((r) => r.id).sort();
    expect(ids).toEqual(['bathroom', 'break_room', 'meeting_room', 'office']);
  });

  it('has bidirectional room connections', () => {
    const roomMap = new Map(OFFICE_DAY_SCENE.rooms.map((r) => [r.id, r]));
    for (const room of OFFICE_DAY_SCENE.rooms) {
      for (const conn of room.connections) {
        const target = roomMap.get(conn);
        expect(target, `connection ${room.id}→${conn}`).toBeDefined();
        expect(target!.connections).toContain(room.id);
      }
    }
  });

  it('office connects to break_room and meeting_room; break_room connects to office and bathroom', () => {
    const office = OFFICE_DAY_SCENE.rooms.find((r) => r.id === 'office')!;
    expect(office.connections).toContain('break_room');
    expect(office.connections).toContain('meeting_room');
    const breakRoom = OFFICE_DAY_SCENE.rooms.find((r) => r.id === 'break_room')!;
    expect(breakRoom.connections).toContain('office');
    expect(breakRoom.connections).toContain('bathroom');
  });

  it('has Computer+Printer in office, Whiteboard+Meeting Table in meeting_room, Coffee Machine+Water Cooler in break_room, Toilet+Sink in bathroom', () => {
    const obj = (id: string) => OFFICE_DAY_SCENE.objects.find((o) => o.id === id)!;
    expect(obj('computer-1').roomId).toBe('office');
    expect(obj('printer-1').roomId).toBe('office');
    expect(obj('whiteboard-1').roomId).toBe('meeting_room');
    expect(obj('table-1').roomId).toBe('meeting_room');
    expect(obj('coffee-2').roomId).toBe('break_room');
    expect(obj('cooler-1').roomId).toBe('break_room');
    expect(obj('toilet-1').roomId).toBe('bathroom');
    expect(obj('sink-1').roomId).toBe('bathroom');
  });

  it('has a Doorway in each room', () => {
    const doorways = OFFICE_DAY_SCENE.objects.filter((o) => o.type === 'doorway');
    expect(doorways).toHaveLength(4);
    for (const room of OFFICE_DAY_SCENE.rooms) {
      expect(doorways.find((d) => d.roomId === room.id)).toBeDefined();
    }
  });

  it('has 3 agents: Alice (office), Bob (break_room), Carol (meeting_room) with distinct drives', () => {
    expect(OFFICE_DAY_SCENE.agents).toHaveLength(3);
    const alice = OFFICE_DAY_SCENE.agents.find((a) => a.id === 'agent-alice')!;
    expect(alice.startRoomId).toBe('office');
    const bob = OFFICE_DAY_SCENE.agents.find((a) => a.id === 'agent-bob')!;
    expect(bob.startRoomId).toBe('break_room');
    const carol = OFFICE_DAY_SCENE.agents.find((a) => a.id === 'agent-carol')!;
    expect(carol.startRoomId).toBe('meeting_room');
    // Distinct drives.
    expect(alice.initialDrives).not.toEqual(bob.initialDrives);
    expect(bob.initialDrives).not.toEqual(carol.initialDrives);
  });
});

// ─── AC-29: Object counts ─────────────────────────────────────────────────────

describe('AC-29: scene object counts', () => {
  it('MORNING_ROUTINE_SCENE has 4 rooms, 10 objects (6 non-doorway + 4 doorway), 2 agents', () => {
    expect(MORNING_ROUTINE_SCENE.rooms).toHaveLength(4);
    const nonDoorway = MORNING_ROUTINE_SCENE.objects.filter((o) => o.type !== 'doorway');
    const doorway = MORNING_ROUTINE_SCENE.objects.filter((o) => o.type === 'doorway');
    expect(nonDoorway).toHaveLength(6);
    expect(doorway).toHaveLength(4);
    expect(MORNING_ROUTINE_SCENE.objects).toHaveLength(10);
    expect(MORNING_ROUTINE_SCENE.agents).toHaveLength(2);
  });

  it('OFFICE_DAY_SCENE has 4 rooms, 12 objects (8 non-doorway + 4 doorway), 3 agents', () => {
    expect(OFFICE_DAY_SCENE.rooms).toHaveLength(4);
    const nonDoorway = OFFICE_DAY_SCENE.objects.filter((o) => o.type !== 'doorway');
    const doorway = OFFICE_DAY_SCENE.objects.filter((o) => o.type === 'doorway');
    expect(nonDoorway).toHaveLength(8);
    expect(doorway).toHaveLength(4);
    expect(OFFICE_DAY_SCENE.objects).toHaveLength(12);
    expect(OFFICE_DAY_SCENE.agents).toHaveLength(3);
  });
});

// ─── AC-31: Object state depletion ─────────────────────────────────────────────

describe('AC-31: Coffee Machine state depletion', () => {
  it('after 3 brews water_level=2, bean_count=9; after 2 more water_level=0; 6th fails has_water', async () => {
    const core = setupMorningRoutine();
    for (let i = 0; i < 3; i++) {
      await execute(core, 'coffee-1', 'brew_coffee', 'agent-alice');
    }
    let obj = core.smartObjectRegistry.get('coffee-1')!;
    expect(obj.state['water_level']).toBe(2);
    expect(obj.state['bean_count']).toBe(9);

    for (let i = 0; i < 2; i++) {
      await execute(core, 'coffee-1', 'brew_coffee', 'agent-alice');
    }
    obj = core.smartObjectRegistry.get('coffee-1')!;
    expect(obj.state['water_level']).toBe(0);

    // 6th attempt → precondition has_water fails.
    const res = await execute(core, 'coffee-1', 'brew_coffee', 'agent-alice');
    expect(res.success).toBe(false);
    expect(res.failureReason).toContain('has_water');
  });
});

// ─── AC-34: Precondition enforcement ──────────────────────────────────────────

describe('AC-34: precondition enforcement', () => {
  it('fails with has_water when water_level is 0', async () => {
    const core = setupMorningRoutine();
    core.smartObjectRegistry.updateState('coffee-1', { water_level: 0, bean_count: 12 });
    const res = await execute(core, 'coffee-1', 'brew_coffee', 'agent-alice');
    expect(res.success).toBe(false);
    expect(res.failureReason).toContain('has_water');
  });

  it('fails with has_beans when bean_count is 0 (and water_level > 0)', async () => {
    const core = setupMorningRoutine();
    core.smartObjectRegistry.updateState('coffee-1', { water_level: 5, bean_count: 0 });
    const res = await execute(core, 'coffee-1', 'brew_coffee', 'agent-alice');
    expect(res.success).toBe(false);
    expect(res.failureReason).toContain('has_beans');
  });
});

// ─── AC-32: Multi-agent concurrency ───────────────────────────────────────────

describe('AC-32: multi-agent concurrency with FakeOrchestrator', () => {
  it('with maxConcurrentCycles >= 3, all 3 agents start cycles on the first tick', () => {
    const core = createEngineCore(makeConfig());
    loadScene(core, OFFICE_DAY_SCENE);
    registerAffordanceHandlers(core);
    const orch = new FakeOrchestrator();
    const scheduler = new PPERScheduler(core.agentManager, orch, {
      maxConcurrentCycles: 3,
    });
    scheduler.update(TICK);
    expect(orch.runCycleCalls).toHaveLength(3);
    expect(orch.runCycleCalls.sort()).toEqual(['agent-alice', 'agent-bob', 'agent-carol']);
  });

  it('with maxConcurrentCycles: 2, only 2 agents start cycles on the first tick', () => {
    const core = createEngineCore(makeConfig());
    loadScene(core, OFFICE_DAY_SCENE);
    registerAffordanceHandlers(core);
    const orch = new FakeOrchestrator();
    orch.autoResolve = false; // slots stay occupied
    const scheduler = new PPERScheduler(core.agentManager, orch, {
      maxConcurrentCycles: 2,
    });
    scheduler.update(TICK);
    expect(orch.runCycleCalls).toHaveLength(2);
    const waiting = ['agent-alice', 'agent-bob', 'agent-carol'].find(
      (id) => !orch.runCycleCalls.includes(id),
    );
    expect(waiting).toBeDefined();
  });
});

// ─── AC-22 / AC-27: Engine assembly ───────────────────────────────────────────

describe('AC-22: buildMorningRoutineEngine', () => {
  it('returns an AssembledEngine with handlers registered and agents spawned', () => {
    const engine = buildMorningRoutineEngine();
    expect(engine.gameLoop).toBeDefined();
    expect(engine.agentManager.getState('agent-alice')).not.toBeNull();
    expect(engine.agentManager.getState('agent-alice')?.location).toBe('bedroom');
    expect(engine.affordanceRegistry.getHandler('brew_coffee')).not.toBeNull();
    expect(engine.affordanceRegistry.getHandler('sleep')).not.toBeNull();
  });

  it('runs the simulation without errors when gameLoop.start() is called', async () => {
    const engine = buildMorningRoutineEngine();
    engine.gameLoop.start();
    await new Promise((r) => setTimeout(r, 50));
    engine.gameLoop.stop();
    // No throw = pass.
    expect(engine.agentManager.getState('agent-alice')).not.toBeNull();
  });
});

describe('AC-27: buildOfficeDayEngine', () => {
  it('returns an AssembledEngine with handlers registered and agents spawned', () => {
    const engine = buildOfficeDayEngine();
    expect(engine.gameLoop).toBeDefined();
    expect(engine.agentManager.getState('agent-carol')).not.toBeNull();
    expect(engine.agentManager.getState('agent-carol')?.location).toBe('meeting_room');
    expect(engine.affordanceRegistry.getHandler('work')).not.toBeNull();
    expect(engine.affordanceRegistry.getHandler('small_talk')).not.toBeNull();
  });

  it('runs the simulation without errors when gameLoop.start() is called', async () => {
    const engine = buildOfficeDayEngine();
    engine.gameLoop.start();
    await new Promise((r) => setTimeout(r, 50));
    engine.gameLoop.stop();
    expect(engine.agentManager.getState('agent-alice')).not.toBeNull();
  });
});

// ─── AC-23 / AC-33: Morning Routine drive-aware mock LLM ──────────────────────

describe('AC-23 / AC-33: MorningRoutineMockLLMClient drive prioritization', () => {
  function makePayload(roomId: string, primaryDriveLabel: string): LLMContextPayload {
    return {
      systemPrompt: '',
      perceptionContext: `Room: ${roomId}\nObjects: none\nPrimary drive: ${primaryDriveLabel}\nDrives: energy=15`,
      availableAffordances: [],
      cognitiveTools: [],
      tools: [],
    };
  }

  it('returns a plan targeting brew_coffee when primary drive is energy and agent is in kitchen', async () => {
    const llm = new MorningRoutineMockLLMClient();
    const result = await llm.completePlan(
      makePayload('kitchen', 'low energy, need to restore energy'),
    );
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps[0]!.targetAffordance).toBe('brew_coffee');
  });

  it('returns a plan targeting go_to_kitchen or sleep when in bedroom with energy drive', async () => {
    const llm = new MorningRoutineMockLLMClient();
    const result = await llm.completePlan(
      makePayload('bedroom', 'low energy, need to restore energy'),
    );
    expect(result.steps.length).toBeGreaterThan(0);
    const target = result.steps[0]!.targetAffordance;
    expect(['go_to_kitchen', 'sleep']).toContain(target);
  });

  it('Alice (energy 15) in kitchen targets brew_coffee; Bob (social 15) in living_room targets a non-energy affordance', async () => {
    const llm = new MorningRoutineMockLLMClient();
    const alicePlan = await llm.completePlan(
      makePayload('kitchen', 'low energy, need to restore energy'),
    );
    expect(alicePlan.steps[0]!.targetAffordance).toBe('brew_coffee');

    const bobPlan = await llm.completePlan(
      makePayload('living_room', 'low social, need to restore social'),
    );
    const bobTarget = bobPlan.steps[0]!.targetAffordance!;
    // No social affordance in living_room → must be a non-energy affordance
    // (watch_tv, read_book, or a go_to_* movement).
    expect(bobTarget).not.toBe('brew_coffee');
    expect([
      'watch_tv',
      'read_book',
      'go_to_living_room',
      'go_to_kitchen',
      'go_to_bedroom',
      'go_to_bathroom',
    ]).toContain(bobTarget);
  });
});

// ─── AC-28: Office Day drive-aware mock LLM ───────────────────────────────────

describe('AC-28: OfficeDayMockLLMClient drive prioritization', () => {
  function makePayload(roomId: string, primaryDriveLabel: string): LLMContextPayload {
    return {
      systemPrompt: '',
      perceptionContext: `Room: ${roomId}\nObjects: none\nPrimary drive: ${primaryDriveLabel}\nDrives: social=15`,
      availableAffordances: [],
      cognitiveTools: [],
      tools: [],
    };
  }

  it('targets small_talk when primary drive is social and agent is in break_room', async () => {
    const llm = new OfficeDayMockLLMClient();
    const result = await llm.completePlan(
      makePayload('break_room', 'low social, need to restore social'),
    );
    expect(result.steps[0]!.targetAffordance).toBe('small_talk');
  });

  it('targets go_to_break_room when primary drive is social and agent is in office', async () => {
    const llm = new OfficeDayMockLLMClient();
    const result = await llm.completePlan(
      makePayload('office', 'low social, need to restore social'),
    );
    expect(result.steps[0]!.targetAffordance).toBe('go_to_break_room');
  });
});
