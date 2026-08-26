/**
 * Scene Definition JSON Schema (spec 022, Req 5)
 * ───────────────────────────────────────────────
 * A JSON Schema (Draft 2020-12) that validates the YAML-parsed scene
 * structure. This schema is the single source of truth for the declarative
 * scene format — the pipeline is "parse YAML → JSON object → validate against
 * this JSON Schema."
 *
 * The raw JSON file lives at `scene-schema.json` alongside this module. We
 * import it at build-time via `resolveJsonModule` and re-export so consumers
 * can `import { sceneDefinitionSchema } from '@evol-hive/shared'`.
 */

import schemaJson from './scene-schema.json';

/** The JSON Schema (Draft 2020-12) for SceneDefinition validation. */
export const sceneDefinitionSchema = schemaJson;
