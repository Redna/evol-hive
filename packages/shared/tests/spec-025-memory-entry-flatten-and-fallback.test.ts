/**
 * Spec 025 — Memory Entry Flatten & Auto-Fallback
 * Tests for the shared layer: reflectSchema flattening (R1) and
 * ReflectLLMResponse type updates (R2).
 *
 * Covers AC-4, AC-5, AC-6.
 */
import { describe, it, expect } from 'vitest';
import type { ReflectLLMResponse, MemoryEntryInput, MemoryType } from '../src/index.js';
import { reflectSchema } from '../src/index.js';

// ─── R1 / AC-4: reflectSchema has flattened top-level properties ─────────────

describe('reflectSchema — flattened memory fields (R1, AC-4)', () => {
  it('has memoryContent as a top-level string property', () => {
    expect(reflectSchema.properties.memoryContent).toMatchObject({ type: 'string' });
  });

  it('has memoryImportance as a top-level integer property with min 1, max 10', () => {
    expect(reflectSchema.properties.memoryImportance).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 10,
    });
  });

  it('has memoryType as a top-level string enum', () => {
    expect(reflectSchema.properties.memoryType).toMatchObject({
      type: 'string',
      enum: ['observation', 'reflection', 'action', 'interaction'],
    });
  });

  it('has memoryLocation as a top-level optional string property', () => {
    expect(reflectSchema.properties.memoryLocation).toMatchObject({ type: 'string' });
  });

  // AC-4: does NOT have a nested memoryEntry property
  it('does NOT have a nested memoryEntry property', () => {
    expect(reflectSchema.properties.memoryEntry).toBeUndefined();
  });
});

// ─── R1.2 / AC-5: reflectSchema required array includes memoryContent ────────

describe('reflectSchema required array (R1.2, AC-5)', () => {
  it('includes "memoryContent" in the required array', () => {
    expect(reflectSchema.required).toContain('memoryContent');
  });

  it('does NOT include memoryImportance, memoryType, or memoryLocation in required', () => {
    expect(reflectSchema.required).not.toContain('memoryImportance');
    expect(reflectSchema.required).not.toContain('memoryType');
    expect(reflectSchema.required).not.toContain('memoryLocation');
  });
});

// ─── R2 / AC-6: ReflectLLMResponse type has flattened fields ─────────────────

describe('ReflectLLMResponse — flattened fields (R2, AC-6)', () => {
  it('accepts memoryContent as an optional string', () => {
    const resp: ReflectLLMResponse = { memoryContent: 'I brewed coffee' };
    expect(resp.memoryContent).toBe('I brewed coffee');
  });

  it('accepts memoryImportance as an optional number', () => {
    const resp: ReflectLLMResponse = { memoryContent: 'x', memoryImportance: 7 };
    expect(resp.memoryImportance).toBe(7);
  });

  it('accepts memoryType as an optional MemoryType', () => {
    const resp: ReflectLLMResponse = { memoryContent: 'x', memoryType: 'action' };
    expect(resp.memoryType).toBe('action');
  });

  it('accepts memoryLocation as an optional string', () => {
    const resp: ReflectLLMResponse = { memoryContent: 'x', memoryLocation: 'kitchen' };
    expect(resp.memoryLocation).toBe('kitchen');
  });

  it('still accepts the legacy memoryEntry field for backward compatibility', () => {
    const entry: MemoryEntryInput = {
      content: 'legacy memory',
      importance: 5,
      type: 'observation',
    };
    const resp: ReflectLLMResponse = { memoryEntry: entry };
    expect(resp.memoryEntry?.content).toBe('legacy memory');
  });

  it('accepts both flattened fields and legacy memoryEntry', () => {
    const resp: ReflectLLMResponse = {
      memoryContent: 'flattened',
      memoryImportance: 8,
      memoryType: 'reflection',
      memoryEntry: { content: 'legacy', importance: 3, type: 'action' },
    };
    expect(resp.memoryContent).toBe('flattened');
    expect(resp.memoryEntry?.content).toBe('legacy');
  });

  it('accepts an empty object (no updates)', () => {
    const resp: ReflectLLMResponse = {};
    expect(resp.memoryContent).toBeUndefined();
    expect(resp.memoryEntry).toBeUndefined();
  });

  it('supports all MemoryType values via memoryType', () => {
    const types: MemoryType[] = ['observation', 'reflection', 'action', 'interaction'];
    for (const t of types) {
      const resp: ReflectLLMResponse = { memoryContent: 'x', memoryType: t };
      expect(resp.memoryType).toBe(t);
    }
  });
});
