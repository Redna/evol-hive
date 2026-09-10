/**
 * Tests for spec 049 — R4: the own-cycle reply window in the conversation
 * manager (issue #167).
 *
 * Covers:
 * - AC-6 (R4): B has `meanCycleIntervalTicks = 3600`; a conversation with
 *   `lastActivity = nowTick − 120` is NOT closed by the tick sweep (today's
 *   code closes it); at `lastActivity = nowTick − 7201` it closes with reason
 *   `idle timeout`.
 * - AC-7 (R4): with `meanCycleIntervalTicks` undefined on all participants,
 *   the effective timeout is the fail-open legacy default
 *   `max(config.idleTimeoutTicks, 2 × DEFAULT_CYCLE_INTERVAL_TICKS)` — the
 *   conversation stays open at the 120-tick raw floor and closes once idle
 *   exceeds `2 × DEFAULT_CYCLE_INTERVAL_TICKS`.
 * - AC-8 (R4): an idle-timeout closure emits one `[conversation]` console line
 *   containing the conversation id, the idle tick count, and the effective
 *   timeout.
 *
 * Spec 033 lifecycle semantics (closure + close-time consolidation) remain
 * intact — the window only WIDENS (Decision 3: fail-open toward possible
 * replies).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { AgentProfile, MemoryEntryInput } from '@evol-hive/shared';
import { DEFAULT_CYCLE_INTERVAL_TICKS } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { ConversationManagerImpl } from '../src/social/conversation-manager.js';

// ── Fixtures (mirrors the spec-033 harness) ──────────────────────────────────

const GARDEN = 'garden';
const KITCHEN = 'kitchen';

function makeProfile(id: string, startRoom: string): AgentProfile {
  return {
    id,
    name: id,
    description: '',
    traits: [],
    initialDrives: {},
    startRoomId: startRoom,
  };
}

interface InteractionRecord {
  agentId: string;
  entry: MemoryEntryInput;
}

function buildWorld(config?: { idleTimeoutTicks: number }): {
  agentManager: AgentManagerImpl;
  manager: ConversationManagerImpl;
  stored: InteractionRecord[];
} {
  const agentManager = new AgentManagerImpl();
  const registry = new SmartObjectRegistryImpl();
  const sceneManager = new SceneManagerImpl(
    agentManager,
    new Map([
      [
        GARDEN,
        { id: GARDEN, name: GARDEN, description: '', connections: [KITCHEN], objectIds: [] },
      ],
      [
        KITCHEN,
        { id: KITCHEN, name: KITCHEN, description: '', connections: [GARDEN], objectIds: [] },
      ],
    ]),
  );
  const stored: InteractionRecord[] = [];
  const manager = new ConversationManagerImpl({
    agentManager,
    registry,
    sceneManager,
    config: config ?? { idleTimeoutTicks: 120, turnWindow: 8 },
    consolidationSink: {
      storeInteraction(agentId: string, entry: MemoryEntryInput): void {
        stored.push({ agentId, entry });
      },
    },
  });
  for (const id of ['agent-a', 'agent-b']) {
    agentManager.spawn(makeProfile(id, GARDEN));
    agentManager.updateState(id, { location: GARDEN });
  }
  return { agentManager, manager, stored };
}

// ── AC-6 — measured cadence widens the window ────────────────────────────────

describe('spec 049 R4 — own-cycle reply window (AC-6)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('a 120-tick-idle conversation with a 3600-tick participant interval is NOT closed', () => {
    // A addresses B at tick 100; B's measured own-cycle cadence is 3600 ticks.
    world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 100);
    world.agentManager.updateState('agent-b', { meanCycleIntervalTicks: 3600 });

    // 121 idle ticks — today's raw 120-tick floor would have closed it here.
    world.manager.tick(100 + 120 + 1);
    const conv = world.manager.getConversation('conv-100-1');
    expect(conv).not.toBeNull();
    expect(conv!.status).not.toBe('closed');
    expect(world.stored).toHaveLength(0);
  });

  it('at 7201 idle ticks the conversation closes with reason idle timeout', () => {
    world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 100);
    world.agentManager.updateState('agent-b', { meanCycleIntervalTicks: 3600 });

    world.manager.tick(100 + 7201);
    const conv = world.manager.getConversation('conv-100-1');
    expect(conv!.status).toBe('closed');
    // The close reason is observable in the close-time consolidation payload.
    expect(world.stored).toHaveLength(2);
    for (const record of world.stored) {
      expect(record.entry.content).toContain('idle timeout');
    }
  });

  it('the effective timeout is the max of the floor and the widest owing participant term', () => {
    // B measured slow (3600 → term 7200); the 120 floor can never close first.
    world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 100);
    world.agentManager.updateState('agent-b', { meanCycleIntervalTicks: 3600 });

    world.manager.tick(100 + 7200);
    expect(world.manager.getConversation('conv-100-1')!.status).not.toBe('closed');
    world.manager.tick(100 + 7201);
    expect(world.manager.getConversation('conv-100-1')!.status).toBe('closed');
  });
});

// ── AC-7 — legacy path (no cadence data) ─────────────────────────────────────

describe('spec 049 R4 — legacy fail-open window (AC-7)', () => {
  let world: ReturnType<typeof buildWorld>;
  beforeEach(() => {
    world = buildWorld();
  });

  it('with no cadence data the conversation stays open at the raw floor and closes past 2 × DEFAULT_CYCLE_INTERVAL_TICKS', () => {
    // Every participant lacks meanCycleIntervalTicks (legacy saves,
    // never-cycled agents) — the window fail-opens to 2 × 3600.
    expect(DEFAULT_CYCLE_INTERVAL_TICKS).toBe(3600);
    world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);

    // At the 120-tick raw floor (and well past it) the conversation is open —
    // an unknown cadence widens rather than narrows the window (Decision 3).
    world.manager.tick(11 + 120 + 1);
    expect(world.manager.getConversation('conv-11-1')!.status).not.toBe('closed');

    // Exactly at the fail-open boundary: not closed (strict >).
    world.manager.tick(11 + 2 * DEFAULT_CYCLE_INTERVAL_TICKS);
    expect(world.manager.getConversation('conv-11-1')!.status).not.toBe('closed');

    // Past it: closed.
    world.manager.tick(11 + 2 * DEFAULT_CYCLE_INTERVAL_TICKS + 1);
    expect(world.manager.getConversation('conv-11-1')!.status).toBe('closed');
  });

  it('a no-turn conversation closes via the sweep past the fail-open window too', () => {
    // Defensive: a conversation object without turns treats ALL participants
    // as owing a reply — same fail-open window, same closure.
    const manager = new ConversationManagerImpl({
      agentManager: world.agentManager,
      registry: new SmartObjectRegistryImpl(),
      sceneManager: new SceneManagerImpl(
        world.agentManager,
        new Map([
          [GARDEN, { id: GARDEN, name: GARDEN, description: '', connections: [], objectIds: [] }],
        ]),
      ),
      config: { idleTimeoutTicks: 120, turnWindow: 8 },
    });
    // Open + immediately strip the opening turn → a no-turn conversation.
    const result = manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 50);
    const conv = manager.getConversation(result.conversation!.id)!;
    conv.turns = [];
    // lastActivity still 50 → past 7250 the no-turn conversation closes.
    manager.tick(50 + 2 * DEFAULT_CYCLE_INTERVAL_TICKS + 1);
    expect(manager.getConversation(result.conversation!.id)!.status).toBe('closed');
  });
});

// ── AC-8 — the [conversation] closure diagnostic ─────────────────────────────

describe('spec 049 R4 — idle-closure diagnostic (AC-8)', () => {
  let world: ReturnType<typeof buildWorld>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    world = buildWorld();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('an idle-timeout closure emits exactly one [conversation] line with id, idle ticks, and effective timeout', () => {
    world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 100);
    world.agentManager.updateState('agent-b', { meanCycleIntervalTicks: 3600 });

    world.manager.tick(100 + 7201);

    const convLines = logSpy.mock.calls
      .map((args) => args.map(String).join(' '))
      .filter((line) => line.includes('[conversation]'));
    expect(convLines).toHaveLength(1);
    const line = convLines[0]!;
    expect(line).toContain('conv-100-1');
    expect(line).toContain('idle=7201');
    expect(line).toContain('effectiveTimeout=7200');
  });

  it('non-idle closures (last participant leaves) emit no [conversation] line', () => {
    const first = world.manager.openOrContribute('agent-a', 'agent-b', 'hi', 'neutral', 11);
    world.manager.leave('agent-a', first.conversation!.id, 12);
    world.manager.leave('agent-b', first.conversation!.id, 13);

    const convLines = logSpy.mock.calls
      .map((args) => args.map(String).join(' '))
      .filter((line) => line.includes('[conversation]'));
    expect(convLines).toHaveLength(0);
  });
});
