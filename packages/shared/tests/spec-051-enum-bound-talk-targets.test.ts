/**
 * Tests for spec 051 — Enum-Bound Conversation Targeting (issue #186) —
 * shared layer.
 *
 * Covers:
 * - AC-1 (R1): `talkToToolFor(['agent-bob'])` produces a tool definition whose
 *   `targetAgentId` schema is `{ type: 'string', enum: ['agent-bob'] }` with
 *   `message`/`sentiment` unchanged. The enum is bound per cycle to the agents
 *   actually present; there is no free-form target string.
 * - R1 backward compat: the static `talkToTool`/`talkToSchema` remain exported
 *   with their pre-051 shape (tests asserting the old shape keep passing).
 * - R3: `SocialActionBridge` gains an OPTIONAL `enumerateTalkTargets` method
 *   (source pin — the optionality is the AC-7 backward-compat guard).
 * - R2 (shared arithmetic): `isSocialTalkGapCapped(sentCount, receivedCount)`
 *   is THE unanswered-gap cap condition — the single computation the cognition
 *   enum builder and the engine enumeration both consume (no duplication).
 * - AC-9 (R5): `SOCIAL_MONOLOGUE_REWARD` remains 2 — the deferred decision is
 *   tracked by telemetry, not by a code change in this spec.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition } from '../src/index.js';
import {
  talkToToolFor,
  talkToSchemaFor,
  talkToTool,
  talkToSchema,
  isSocialTalkGapCapped,
  SOCIAL_TALK_CAP,
  SOCIAL_MONOLOGUE_REWARD,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COGNITION_TYPES_PATH = resolve(HERE, '../src/types/cognition.ts');

// ─── AC-1 (R1): the per-cycle enum-bound talk_to factory ─────────────────────

describe('talkToToolFor (R1, AC-1)', () => {
  it('enum-binds targetAgentId to the given valid target IDs', () => {
    const tool: ToolDefinition = talkToToolFor(['agent-bob']);
    expect(tool.function.name).toBe('talk_to');
    const target = tool.function.parameters.properties.targetAgentId;
    expect(target).toEqual({
      type: 'string',
      enum: ['agent-bob'],
      description: 'an agent ID from the enum (agents present right now, not past the unanswered cap)',
    });
  });

  it('preserves the given enum order (deterministic per-cycle binding)', () => {
    const tool = talkToToolFor(['agent-maren', 'agent-iris', 'agent-bob']);
    const target = tool.function.parameters.properties.targetAgentId;
    expect(target.enum).toEqual(['agent-maren', 'agent-iris', 'agent-bob']);
  });

  it('leaves message and sentiment unchanged', () => {
    const tool = talkToToolFor(['agent-bob']);
    expect(tool.function.parameters.properties.message).toEqual(talkToSchema.properties.message);
    expect(tool.function.parameters.properties.sentiment).toEqual(
      talkToSchema.properties.sentiment,
    );
  });

  it('keeps the required list and additionalProperties:false', () => {
    const tool = talkToToolFor(['agent-bob']);
    expect(tool.function.parameters.required).toEqual(['targetAgentId', 'message']);
    expect(tool.function.parameters.additionalProperties).toBe(false);
  });

  it('is a plain function factory — no shared mutable state between calls', () => {
    const a = talkToToolFor(['agent-a']);
    const b = talkToToolFor(['agent-b']);
    expect(a.function.parameters.properties.targetAgentId.enum).toEqual(['agent-a']);
    expect(b.function.parameters.properties.targetAgentId.enum).toEqual(['agent-b']);
  });
});

describe('talkToSchemaFor (R1 — schema factory behind the tool factory)', () => {
  it('carries the enum on targetAgentId', () => {
    const schema = talkToSchemaFor(['agent-bob']);
    expect(schema.properties.targetAgentId.enum).toEqual(['agent-bob']);
  });

  it('empty valid-target list: no enum property (spec 037/039 empty-value-space pattern) — builders must not OFFER the tool at all', () => {
    // The tool is omitted from the tools array when nothing is valid (AC-4);
    // the factory itself stays total by omitting the enum, never emitting an
    // illegal empty enum (spec 037 lesson).
    const schema = talkToSchemaFor([]);
    expect(schema.properties.targetAgentId).not.toHaveProperty('enum');
    expect(schema.properties.targetAgentId.type).toBe('string');
  });
});

// ─── R1 backward compat: static talk_to schema shape unchanged ───────────────

describe('static talkToTool / talkToSchema remain backward compatible', () => {
  it('the static schema keeps its free-form targetAgentId (no enum)', () => {
    expect(talkToSchema.properties.targetAgentId).not.toHaveProperty('enum');
    expect(talkToSchema.required).toEqual(['targetAgentId', 'message']);
    expect(talkToSchema.additionalProperties).toBe(false);
  });

  it('the static talkToTool still carries name talk_to with the static schema', () => {
    expect(talkToTool.function.name).toBe('talk_to');
    expect(talkToTool.function.parameters).toBe(talkToSchema);
  });
});

// ─── R3: SocialActionBridge gains an OPTIONAL enumerateTalkTargets ───────────

describe('SocialActionBridge.enumerateTalkTargets (R3 — source pin)', () => {
  it('is declared OPTIONAL in the shared interface (the AC-7 typeof guard basis)', () => {
    const source = readFileSync(COGNITION_TYPES_PATH, 'utf8');
    const start = source.indexOf('export interface SocialActionBridge');
    expect(start).toBeGreaterThan(-1);
    // Cut at the next interface declaration so the assertion cannot match an
    // unrelated block.
    const block = source.slice(start, source.indexOf('}', source.indexOf('{', start)));
    expect(block).toContain('enumerateTalkTargets?(');
    // The spec 046 method stays REQUIRED — no interface break.
    expect(block).toContain('resolveAgentId(requesterAgentId: string, nameOrId: string): string | null;');
  });
});

// ─── R2 shared arithmetic: the unanswered-gap cap condition ──────────────────

describe('isSocialTalkGapCapped (R2 — single cap computation)', () => {
  it('gap ≥ SOCIAL_TALK_CAP is capped; below is not', () => {
    expect(SOCIAL_TALK_CAP).toBe(3);
    expect(isSocialTalkGapCapped(3, 0)).toBe(true);
    expect(isSocialTalkGapCapped(2, 0)).toBe(false);
    expect(isSocialTalkGapCapped(4, 1)).toBe(true);
    expect(isSocialTalkGapCapped(3, 3)).toBe(false);
    expect(isSocialTalkGapCapped(0, 0)).toBe(false);
  });
});

// ─── AC-9 (R5): the monologue reward is intentionally unchanged ──────────────

describe('SOCIAL_MONOLOGUE_REWARD unchanged (R5, AC-9)', () => {
  it('remains 2 — the deferred sign decision is tracked by R4 telemetry', () => {
    expect(SOCIAL_MONOLOGUE_REWARD).toBe(2);
  });
});