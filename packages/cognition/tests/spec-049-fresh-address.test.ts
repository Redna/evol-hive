/**
 * Tests for spec 049 — R3: fresh-address salience in the perception-builder
 * (issue #167).
 *
 * Covers:
 * - AC-4 (R3): a pending address with
 *   `currentTick − lastTurnTick < SOCIAL_PENDING_FRESH_TICKS` renders the
 *   `FRESH: INFORMATION: …` line as the FIRST dynamic line; the same pending
 *   address past the threshold renders today's line in today's position.
 * - AC-5 (R3, R5): the fresh line never appears in `stableLines` (spec 021
 *   assertion on the built prompt sections), and no scheduler/enqueue behavior
 *   changes when a fresh pending address exists — promotion is a pure
 *   reordering inside the dynamic section (tools and stable section are
 *   byte-identical between a fresh and a stale pending address).
 */
import { describe, it, expect } from 'vitest';
import type {
  AgentSummary,
  PendingAddressInfo,
  PerceptionResult,
  SocialUrgeAssessment,
} from '@evol-hive/shared';
import { SOCIAL_PENDING_FRESH_TICKS, computeSocialUrge } from '@evol-hive/shared';
import { PerceptionBuilderImpl } from '../src/pper/perception-builder.js';

const ALICE = makeAgentSummary('agent-a', 'Alice');

function makeAgentSummary(agentId: string, name: string): AgentSummary {
  return { agentId, name, currentActivity: 'idle', isThinking: false };
}

function makePending(ageTicks: number, currentTick: number): PendingAddressInfo {
  return {
    conversationId: 'conv-900-1',
    fromAgentId: 'agent-a',
    content: 'Hello there!',
    lastTurnTick: currentTick - ageTicks,
    currentTick,
  };
}

function makePerceptionResult(
  pendingAddresses: PendingAddressInfo[] | undefined,
): PerceptionResult {
  return {
    passive: {
      roomId: 'garden',
      objectsPresent: [],
      drives: { energy: 50, hunger: 50, social: 60, comfort: 50, curiosity: 50 },
      agentsPresent: [ALICE],
    },
    prunedAffordances: [],
    primaryDriveLabel: 'low energy, need to restore energy',
    pendingAddresses,
  };
}

/** Split a perceptionContext at the `---` separator into [stable, dynamic]. */
function splitSections(context: string): { stable: string[]; dynamic: string[] } {
  const lines = context.split('\n');
  const sep = lines.indexOf('---');
  expect(sep, 'perceptionContext must contain a --- separator line').toBeGreaterThan(-1);
  return { stable: lines.slice(0, sep), dynamic: lines.slice(sep + 1) };
}

const FRESH_LINE =
  'FRESH: INFORMATION: Alice addressed you, awaiting response: "Hello there!"';
const STALE_LINE = 'INFORMATION: Alice addressed you, awaiting response: "Hello there!"';

// ── AC-4 — fresh vs stale rendering ──────────────────────────────────────────

describe('spec 049 R3 — fresh-address salience (AC-4)', () => {
  const builder = new PerceptionBuilderImpl();

  it('a fresh pending address renders the FRESH line as the FIRST dynamic line', () => {
    const fresh = makePending(SOCIAL_PENDING_FRESH_TICKS - 1, 5000);
    const { dynamic } = splitSections(builder.build(makePerceptionResult([fresh])).perceptionContext);

    expect(dynamic[0]).toBe(FRESH_LINE);
    // The other dynamic lines follow unchanged behind the promotion.
    expect(dynamic).toContain('Primary drive: low energy, need to restore energy');
  });

  it('the same pending address past the threshold renders today line in today position', () => {
    const stale = makePending(SOCIAL_PENDING_FRESH_TICKS + 1, 5000);
    const { dynamic } = splitSections(
      builder.build(makePerceptionResult([stale])).perceptionContext,
    );

    // Today's position: after the primary-drive and drives lines, no FRESH prefix.
    expect(dynamic[0]).toBe('Primary drive: low energy, need to restore energy');
    expect(dynamic[1]).toBe('Drives: energy=50, hunger=50, social=60, comfort=50, curiosity=50');
    expect(dynamic[2]).toBe(STALE_LINE);
  });

  it('pending entries without tick data (legacy providers) render today line today position', () => {
    const legacy: PendingAddressInfo = {
      conversationId: 'conv-900-1',
      fromAgentId: 'agent-a',
      content: 'Hello there!',
    };
    const { dynamic } = splitSections(
      builder.build(makePerceptionResult([legacy])).perceptionContext,
    );

    expect(dynamic[2]).toBe(STALE_LINE);
    expect(dynamic.some((line) => line.startsWith('FRESH:'))).toBe(false);
  });

  it('SOCIAL_PENDING_FRESH_TICKS is the spec value 3600', () => {
    expect(SOCIAL_PENDING_FRESH_TICKS).toBe(3600);
  });
});

// ── AC-5 — spec 021 KV-cache discipline + no other behavior change ──────────

describe('spec 049 R3 — dynamic-section-only promotion (AC-5)', () => {
  const builder = new PerceptionBuilderImpl();

  it('the FRESH line never appears in the stable section', () => {
    const fresh = makePending(10, 5000);
    const { stable, dynamic } = splitSections(
      builder.build(makePerceptionResult([fresh])).perceptionContext,
    );

    expect(stable.join('\n')).not.toContain('FRESH:');
    expect(stable.join('\n')).not.toContain('addressed you');
    expect(dynamic.join('\n')).toContain(FRESH_LINE);
  });

  it('promotion is a pure reordering: tools and stable section are identical for fresh vs stale', () => {
    const fresh = makePending(10, 5000);
    const stale = makePending(SOCIAL_PENDING_FRESH_TICKS + 10, 5000);

    const freshPayload = builder.build(makePerceptionResult([fresh]));
    const stalePayload = builder.build(makePerceptionResult([stale]));

    expect(freshPayload.tools).toEqual(stalePayload.tools);
    expect(freshPayload.systemPrompt).toBe(stalePayload.systemPrompt);
    // The only difference is the promoted FRESH prefix + position.
    expect(freshPayload.perceptionContext).not.toBe(stalePayload.perceptionContext);
    expect(freshPayload.perceptionContext).toContain('FRESH: INFORMATION:');
    expect(stalePayload.perceptionContext).not.toContain('FRESH:');
  });

  it('urge hint lines and other dynamic lines are unaffected by a fresh pending address', () => {
    const fresh = makePending(10, 5000);
    const result = makePerceptionResult([fresh]);
    // A surfaced urge toward Alice — must render exactly as today, after the
    // promoted pending line.
    const urge: SocialUrgeAssessment = {
      targetAgentId: 'agent-a',
      result: computeSocialUrge({
        personaSeed: 0.8,
        socialDrive: 20,
        currentTick: 5000,
        relationship: { trust: 50, familiarity: 0 },
      }),
      sentCount: 0,
      receivedCount: 0,
    };
    result.socialUrges = [urge];

    const { dynamic } = splitSections(builder.build(result).perceptionContext);

    expect(dynamic[0]).toBe(FRESH_LINE);
    expect(dynamic).toContain('You feel like talking to Alice.');
    expect(dynamic.indexOf('You feel like talking to Alice.')).toBeGreaterThan(0);
  });
});