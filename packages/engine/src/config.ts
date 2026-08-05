// config/ — Engine runtime configuration loaded from environment
// ──────────────────────────────────────────────────────────────────
// Section 9: Engine config values are loaded from environment variables
// (see .env.example). Defaults match the .env.example values.

/** Spatial debounce configuration loaded from environment. */
export interface SpatialDebounceConfig {
  /** Seconds of idleness before triggering a perception tick. */
  spatialDebounceSeconds: number;
}

/**
 * Load spatial debounce config from environment variables.
 * Default: ENGINE_SPATIAL_DEBOUNCE_SECONDS=5
 */
export function loadSpatialDebounceConfig(): SpatialDebounceConfig {
  return {
    spatialDebounceSeconds: Number(process.env['ENGINE_SPATIAL_DEBOUNCE_SECONDS'] ?? 5),
  };
}
