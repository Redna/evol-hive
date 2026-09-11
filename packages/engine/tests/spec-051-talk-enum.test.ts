/**
 * Tests for spec 051 — Enum-Bound Conversation Targeting (issue #186) —
 * engine layer.
 *
 * Covers:
 * - R3: `SocialManager.enumerateTalkTargets(requesterAgentId)` — the per-cycle
 *   valid talk targets for the requester: co-located ACTIVE agents minus any
 *   target whose unanswered gap (`sentCount − receivedCount`) is at or above
 *   SOCIAL_TALK_CAP. The exclusion is per-target; replies clear it
 *   mechanically (no cooldown timer). Deterministic — no LLM anywhere.
 * - AC-6 (engine half): the enumeration data the executor validates against —
 *   a capped target is absent from the list the engine reports.
 * - AC-7 (interface pin): `enumerateTalkTargets` is optional on
 *   `SocialActionBridge` — bridges predating spec 051 stay valid.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { SmartObjectRegistryImpl } from '../src/world/objects/index.js';
import { SceneManagerImpl } from '../src/world/scenes/index.js';
import { SocialManager } from '../src/social/social-manager.js';
import { SOCIAL_TALK_CAP } from '@evol-hive/shared';
import type { AgentProfile } from '@evol-hive/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const COGNITION_TYPES_PATH = resolve(HERE, '../../shared/src/types/cognition.ts');

// ── Fixtures (mirroring the spec 046 engine suite) ───────────────────────────

const GARDEN = 'garden';
const KITCHEN = 'kitchen';

function makeProfile(id: string, name: string, startRoom: string): AgentProfile {
  return {
    id,
    name,
    description: '',
    traits: [],
    initialDrives: {},
    startRoomId: startRoom,
  };
}

function buildWorld(): { agentManager: AgentManagerImpl; social: SocialManager } {
  const agentManager = new AgentManagerImpl();
  const registry = new SmartObjectRegistryImpl();
  const sceneManager = new SceneManagerImpl(
    agentManager,
    new Map([
      [GARDEN, { id: GARDEN, name: GARDEN, description: '', connections: [KITCHEN], objectIds: [] }],
      [KITCHEN, { id: KITCHEN, name: KITCHEN, description: '', connections: [GARDEN], objectIds: [] }],
    ]),
  );
  void registry;
  void sceneManager;
  const social = new SocialManager(agentManager);
  return { agentManager, social };
}

/** alice + bob + carol co-located in the garden; dave alone in the kitchen. */
function spawnAgents(agentManager: AgentManagerImpl): void {
  agentManager.spawn(makeProfile('agent-alice', 'Alice', GARDEN));
  agentManager.spawn(makeProfile('agent-bob', 'Bob', GARDEN));
  agentManager.spawn(makeProfile('agent-carol', 'Carol', GARDEN));
  agentManager.spawn(makeProfile('agent-dave', 'Dave', KITCHEN));
  agentManager.updateState('agent-alice', { location: GARDEN });
  agentManager.updateState('agent-bob', { location: GARDEN });
  agentManager.updateState('agent-carol', { location: GARDEN });
  agentManager.updateState('agent-dave', { location: KITCHEN });
}

describe('SocialManager.enumerateTalkTargets (R3)', () => {
  let world: ReturnType<typeof buildWorld>;

  beforeEach(() => {
    world = buildWorld();
    spawnAgents(world.agentManager);
  });

  it('lists co-located active agents (uncapped), excluding the requester and other-room agents', () => {
    const valid = world.social.enumerateTalkTargets('agent-alice');
    expect(valid).toContain('agent-bob');
    expect(valid).toContain('agent-carol');
    expect(valid).not.toContain('agent-alice');
    expect(valid).not.toContain('agent-dave');
    expect(valid).toHaveLength(2);
  });

  it('a target at or past SOCIAL_TALK_CAP unanswered is excluded (AC-6 engine half)', () => {
    expect(SOCIAL_TALK_CAP).toBe(3);
    // The real additive write path: alice has sent 3 unanswered to bob.
    world.social.updateRelationship('agent-alice', 'agent-bob', { sentCount: 3 });
    const valid = world.social.enumerateTalkTargets('agent-alice');
    expect(valid).toEqual(['agent-carol']);
  });

  it('the exclusion is per-target: other co-located targets remain valid', () => {
    world.social.updateRelationship('agent-alice', 'agent-bob', { sentCount: 4 });
    const valid = world.social.enumerateTalkTargets('agent-alice');
    expect(valid).toEqual(['agent-carol']);
    // The TARGET's own counters toward alice never gate alice's list.
    world.social.updateRelationship('agent-bob', 'agent-alice', { sentCount: 9 });
    expect(world.social.enumerateTalkTargets('agent-alice')).toEqual(['agent-carol']);
  });

  it('a reply clears the exclusion mechanically — no cooldown timer (AC-5 engine half)', () => {
    world.social.updateRelationship('agent-alice', 'agent-bob', { sentCount: 3 });
    expect(world.social.enumerateTalkTargets('agent-alice')).toEqual(['agent-carol']);
    // bob replies: alice's receivedCount catches up → gap 0 < cap.
    world.social.updateRelationship('agent-alice', 'agent-bob', { receivedCount: 3 });
    const valid = world.social.enumerateTalkTargets('agent-alice');
    expect(valid).toEqual(['agent-bob', 'agent-carol']);
  });

  it('gap exactly one below the cap stays valid (boundary)', () => {
    world.social.updateRelationship('agent-alice', 'agent-bob', { sentCount: 2 });
    expect(world.social.enumerateTalkTargets('agent-alice')).toEqual(['agent-bob', 'agent-carol']);
  });

  it('an agent with no relationships object is uncapped (fresh pair)', () => {
    const state = world.agentManager.getState('agent-alice');
    expect(state?.relationships).toBeUndefined();
    expect(world.social.enumerateTalkTargets('agent-alice')).toEqual(['agent-bob', 'agent-carol']);
  });

  it('a despawned agent is not enumerated (active agents only)', () => {
    world.agentManager.despawn('agent-carol');
    expect(world.social.enumerateTalkTargets('agent-alice')).toEqual(['agent-bob']);
  });

  it('an unknown requester enumerates to an empty list (no crash)', () => {
    expect(world.social.enumerateTalkTargets('agent-ghost')).toEqual([]);
  });

  it('a requester alone in a room enumerates to an empty list', () => {
    expect(world.social.enumerateTalkTargets('agent-dave')).toEqual([]);
  });
});

describe('SocialActionBridge.enumerateTalkTargets optionality (AC-7 pin)', () => {
  it('the shared interface declares the method optional — pre-051 bridges stay assignable', () => {
    const source = readFileSync(COGNITION_TYPES_PATH, 'utf8');
    const start = source.indexOf('export interface SocialActionBridge');
    // Cut at the interface's closing brace — the first line that is exactly
    // `}` after the declaration (doc-comment braces never start a line).
    const block = source.slice(start, source.indexOf('\n}', start));
    expect(block).toContain('enumerateTalkTargets?(');
  });
});