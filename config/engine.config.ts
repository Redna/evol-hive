/**
 * Engine Configuration
 * ───────────────────
 * This file defines the runtime configuration schema for the deterministic engine.
 * Values are loaded from environment variables (see .env.example).
 */

import type { EngineConfig, GuardrailConfig } from '@evol-hive/shared';
import { defaultGuardrailConfig } from '@evol-hive/shared';

export interface EngineRuntimeConfig {
  fps: number;
  spatialDebounceSeconds: number;
  maxConcurrentLLM: number;
  guardrailsEnabled: boolean;
  guardrails: GuardrailConfig;
}

/**
 * Parse a boolean environment variable. Returns `true` for "true"/"1"/"yes",
 * `false` for "false"/"0"/"no", and the provided default when unset or empty.
 */
function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return defaultValue;
}

/**
 * Loads the engine configuration from environment variables (spec 016, Req 14).
 *
 * Guardrail env vars:
 *   - `ENGINE_GUARDRAILS_ENABLED` (default `true`) — master toggle.
 *   - `ENGINE_GUARDRAILS_AFFORDANCE_MASKING` (default `true`)
 *   - `ENGINE_GUARDRAILS_CONTEXTUAL_FORCING` (default `true`)
 *   - `ENGINE_GUARDRAILS_PLAN_VALIDATION` (default `true`)
 *
 * When the master toggle is `false`, all three guardrails are disabled regardless
 * of individual flags.
 */
export function loadEngineConfig(): EngineConfig {
  const guardrailsEnabled = parseBoolEnv(process.env['ENGINE_GUARDRAILS_ENABLED'], true);

  const guardrails: GuardrailConfig = guardrailsEnabled
    ? {
        affordanceMasking: parseBoolEnv(
          process.env['ENGINE_GUARDRAILS_AFFORDANCE_MASKING'],
          true,
        ),
        contextualForcing: parseBoolEnv(
          process.env['ENGINE_GUARDRAILS_CONTEXTUAL_FORCING'],
          true,
        ),
        planValidation: parseBoolEnv(
          process.env['ENGINE_GUARDRAILS_PLAN_VALIDATION'],
          true,
        ),
      }
    : defaultGuardrailConfig();

  return {
    fps: Number(process.env['ENGINE_FPS'] ?? 60),
    spatialDebounceSeconds: Number(process.env['ENGINE_SPATIAL_DEBOUNCE_SECONDS'] ?? 5),
    maxConcurrentLLM: Number(process.env['ENGINE_MAX_CONCURRENT_LLM'] ?? 8),
    guardrailsEnabled,
    guardrails,
    driveDecayRate: Number(process.env['ENGINE_DRIVE_DECAY_RATE'] ?? 0.1),
  };
}