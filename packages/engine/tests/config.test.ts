import { describe, it, expect, afterEach } from 'vitest';
import { loadSpatialDebounceConfig } from '../src/config.js';

describe('Engine config — env-driven thresholds', () => {
  afterEach(() => {
    delete process.env['ENGINE_SPATIAL_DEBOUNCE_SECONDS'];
  });

  it('loads spatialDebounceSeconds from env', () => {
    process.env['ENGINE_SPATIAL_DEBOUNCE_SECONDS'] = '10';
    const config = loadSpatialDebounceConfig();
    expect(config.spatialDebounceSeconds).toBe(10);
  });

  it('defaults to 5 when env var is not set', () => {
    delete process.env['ENGINE_SPATIAL_DEBOUNCE_SECONDS'];
    const config = loadSpatialDebounceConfig();
    expect(config.spatialDebounceSeconds).toBe(5);
  });
});
