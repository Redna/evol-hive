/**
 * validate-scene command — loads and validates a scene file (spec 022, Req 15)
 * ────────────────────────────────────────────────────────────────────────────
 * Loads a `.yaml`, `.yml`, or `.json` scene file, validates it against the
 * JSON Schema, and prints either "✅ Scene is valid" or a list of validation
 * errors with field paths. Exit code 0 on success, 1 on failure.
 */

import { loadSceneFile, SceneValidationError } from '@evol-hive/engine';

/**
 * Validate a scene file and print the result.
 *
 * @param args - Command arguments. Expects the file path as args[0].
 * @returns Exit code (0 = success, 1 = failure).
 */
export async function validateSceneCommand(args: string[]): Promise<number> {
  const filePath = args[0];

  if (!filePath) {
    console.error('Usage: evol-hive validate-scene <file>');
    console.error('  Validates a .scene.yaml or .scene.json file against the JSON Schema.');
    return 1;
  }

  try {
    await loadSceneFile(filePath);
    console.log('✅ Scene is valid');
    return 0;
  } catch (err) {
    if (err instanceof SceneValidationError) {
      console.error(`❌ Scene validation failed: ${err.filePath}`);
      console.error('');
      for (const error of err.errors) {
        const path = error.instancePath || '/';
        console.error(`  ${path}: ${error.message}`);
      }
      console.error('');
      console.error(`${err.errors.length} validation error(s).`);
    } else {
      console.error(`❌ Error: ${(err as Error).message}`);
    }
    return 1;
  }
}
