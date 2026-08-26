#!/usr/bin/env node
/**
 * evol-hive CLI entry point (spec 022, Req 13)
 * ────────────────────────────────────────────────────────────────────────────
 * Dispatches to one of three commands: create-scene, validate-scene, run-scene.
 * Usage: `npx evol-hive <command> [args]`
 */

import { validateSceneCommand } from './validate-scene.js';
import { createSceneCommand } from './create-scene.js';
import { runSceneCommand } from './run-scene.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error('Usage: evol-hive <command> [args]');
    console.error('');
    console.error('Commands:');
    console.error('  create-scene          Interactive wizard to create a .scene.yaml file');
    console.error('  validate-scene <file> Validate a scene file against the JSON Schema');
    console.error('  run-scene <file>      Load and run a scene simulation');
    process.exit(1);
  }

  const cmdArgs = args.slice(1);
  let exitCode: number;

  switch (command) {
    case 'create-scene':
      exitCode = await createSceneCommand(cmdArgs);
      break;
    case 'validate-scene':
      exitCode = await validateSceneCommand(cmdArgs);
      break;
    case 'run-scene':
      exitCode = await runSceneCommand(cmdArgs);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Available commands: create-scene, validate-scene, run-scene');
      exitCode = 1;
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
