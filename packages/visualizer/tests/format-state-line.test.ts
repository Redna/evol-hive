import { describe, it, expect } from 'vitest';
import { formatStateLine } from '../src/renderer/canvas-renderer.js';

describe('formatStateLine (issue #105)', () => {
  it('rounds numeric values to 1 decimal — no more 95.666666674', () => {
    const line = formatStateLine('water_supply', 95.666666674);
    expect(line).not.toContain('95.666666674');
    expect(line).toContain('95.7');
  });

  it('keeps the value visible even for long keys', () => {
    const line = formatStateLine('water_supply', 95.7);
    expect(line).toContain('95.7');
  });

  it('stays within the chip width', () => {
    const line = formatStateLine('water_supply', 95.7);
    expect(line.length * 5.5).toBeLessThanOrEqual(56 + 5.5); // one char tolerance
  });

  it('handles string and boolean values', () => {
    expect(formatStateLine('made', 'true')).toContain('true');
    expect(formatStateLine('on', true)).toContain('true');
  });

  it('handles integer state values', () => {
    expect(formatStateLine('water_level', 4)).toContain(': 4');
  });
});
