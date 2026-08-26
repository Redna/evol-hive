# Feature: Scene Authoring — Declarative Tools for Defining Rooms, Objects, Agents

## Context
- Architecture: [§2 — System Overview](../architecture/02-system-overview.md), [§4 — Smart Objects & Affordances](../architecture/04-smart-objects.md), [§3 — Agent State Schema](../architecture/03-agent-state-schema.md)
- Related specs: [005 — Game Loop Integration & Minimal Scene](005-game-loop-integration.md), [013 — Richer Prototype Scenes](013-richer-prototype-scenes.md), [017 — Persistence](017-persistence-save-load-game-state.md), [018 — Object Interactions](018-object-interactions.md), [019 — Affordance-as-Tools](019-affordance-as-tools.md)
- Package: `@evol-hive/shared` (schema types), `@evol-hive/engine` (scene loader), root monorepo package (CLI)
- Issue: [#90](https://github.com/Redna/evol-hive/issues/90)

## Requirements

### Scene Definition Format

- **Req 1 — YAML schema**: Define a YAML-based declarative scene format (`*.scene.yaml`) that maps 1:1 to the existing `SceneDefinition` interface (`packages/shared/src/types/world.ts`). Fields: `id`, `name`, `rooms[]`, `objects[]`, `agents[]`.
- **Req 2 — Room schema**: Each room entry in YAML supports `id`, `name`, `description`, `connections` (list of room IDs), and `objectIds` (list of object IDs placed in the room).
- **Req 3 — Object schema**: Each object entry supports all `SmartObject` fields: `id`, `name`, `type`, `state` (arbitrary key-value map), `roomId`, `affordances[]` (with `id`, `label`, `engineEffect`, `preconditions[]`, `effects`), and optional `stateRules[]`, `compoundActions[]`, `dependencies[]` per spec 018.
- **Req 4 — Agent schema**: Each agent entry supports all `AgentProfile` fields: `id`, `name`, `description`, `traits[]`, `initialDrives` (partial `AgentDrives`), optional `backstory`, `longTermGoals[]`, `behavioralTendencies[]`, `speechStyle`, `relationships` (map of agentId → description string), and optional `startRoomId`.
- **Req 5 — JSON Schema validation**: Publish a JSON Schema (Draft 2020-12) document that validates the YAML-parsed scene structure. The schema is the single source of truth — the YAML format is "parse YAML → JSON object → validate against JSON Schema."
- **Req 6 — Affordance condition support**: The object schema includes optional `conditions` (list of `AffordanceCondition` with `field`, `operator`, `value`) and `stepGroup`/`stepOrder` fields on affordances, matching the existing `Affordance` type.

### Scene Loader

- **Req 7 — YAML/JSON file loading**: Provide a `loadSceneFile(filePath: string): Promise<SceneDefinition>` function that reads a `.yaml`, `.yml`, or `.json` file, parses it, validates it against the JSON Schema, and returns a `SceneDefinition`.
- **Req 8 — Validation error reporting**: When validation fails, throw a `SceneValidationError` that includes the file path, a list of human-readable validation errors (JSON Pointer paths + messages), and the raw parsed object for debugging.
- **Req 9 — Engine integration**: The loader output is compatible with the existing `loadScene(core, scene)` function in `packages/engine/src/assembly.ts`. No changes to `loadScene` or `EngineCore` are required.
- **Req 10 — Affordance handler auto-registration**: Provide an `AffordanceHandlerRegistry` that maps object `type` values (e.g., `appliance`, `fixture`, `furniture`, `doorway`, `nature`) to handler-registration functions. The loader calls the appropriate registrars after `loadScene` so that `engineEffect` handlers and `PreconditionChecker`s are wired without user code.
- **Req 11 — Plugin system for custom handlers**: Provide a `registerHandlerPlugin(plugin: HandlerPlugin)` API where a `HandlerPlugin` specifies `{ objectType: string, handlers: Record<string, AffordanceHandlerFn>, preconditionCheckers?: Record<string, PreconditionCheckerFn> }`. Plugins are registered before loading a scene and are invoked by the auto-registration step for matching object types. Built-in handlers (from `examples/scene-helpers.ts`) are refactored into the default plugin set.
- **Req 12 — Doorway auto-generation**: When a room has `connections` but no explicit doorway object is listed in `objectIds`, the loader auto-generates a `doorway-<roomId>` smart object with `go_to_<conn>` affordances for each connection, matching the pattern in `examples/coffee-shop.ts` (`makeDoorway`).

### Scene Editor (CLI)

- **Req 13 — CLI binary**: Add a CLI entry point (`packages/cli/` or root `bin/evol-hive.ts`) exposed as `npx evol-hive <command>`. Commands: `create-scene`, `validate-scene`, `run-scene`.
- **Req 14 — `create-scene` command**: Interactive (using `readline` or `@inquirer/prompts`) wizard that prompts for scene name, rooms (name, description, connections), objects (name, type, affordances), and agents (name, drives, start room). Outputs a valid `.scene.yaml` file.
- **Req 15 — `validate-scene <file>` command**: Loads a scene file, validates it against the JSON Schema, and prints either "✅ Scene is valid" or a list of validation errors with field paths. Exit code 0 on success, 1 on failure.
- **Req 16 — `run-scene <file>` command**: Loads a scene file, builds the engine (using `createEngineCore` + `loadScene` + `assembleGameLoop` with a real or mock LLM based on `USE_REAL_LLM` env var), registers affordance handlers, starts the game loop, and runs the simulation for a configurable duration (default 10s mock / 300s real). Prints periodic agent state snapshots.
- **Req 17 — Example YAML scene**: Provide at least one example `.scene.yaml` file (e.g., `examples/coffee-shop.scene.yaml`) that is the declarative equivalent of `examples/coffee-shop.ts`. This example must pass `validate-scene`.

### Backward Compatibility

- **Req 18 — Existing TypeScript scenes unaffected**: All existing example scenes (`coffee-shop.ts`, `minimal-scene.ts`, `morning-routine.ts`, `office-day.ts`) and their tests must continue to work without modification. The `SceneDefinition` interface and `loadScene` function signatures are unchanged.
- **Req 19 — All existing tests pass**: `pnpm -r run test` must pass with zero regressions.

## Acceptance Criteria

- [ ] **AC-1**: A JSON Schema file (`packages/shared/src/schemas/scene-schema.json`) exists and validates the structure of `SceneDefinition` — rooms, objects, agents, and all sub-fields. (maps to Req 1, Req 5)
- [ ] **AC-2**: A YAML file with rooms containing `id`, `name`, `description`, `connections`, `objectIds` passes schema validation. (maps to Req 2)
- [ ] **AC-3**: A YAML file with objects containing `id`, `name`, `type`, `state`, `roomId`, `affordances` (with `id`, `label`, `engineEffect`, `preconditions`, `effects`), `stateRules`, `compoundActions`, `dependencies` passes schema validation. (maps to Req 3, Req 6)
- [ ] **AC-4**: A YAML file with agents containing `id`, `name`, `description`, `traits`, `initialDrives`, `backstory`, `longTermGoals`, `behavioralTendencies`, `speechStyle`, `relationships`, `startRoomId` passes schema validation. (maps to Req 4)
- [ ] **AC-5**: `loadSceneFile('path/to/scene.yaml')` returns a `SceneDefinition` object whose rooms, objects, and agents match the YAML content. (maps to Req 7)
- [ ] **AC-6**: `loadSceneFile('path/to/scene.json')` returns a valid `SceneDefinition` from a JSON file. (maps to Req 7)
- [ ] **AC-7**: Loading a file with a missing required field (e.g., no `name` on a room) throws a `SceneValidationError` containing the file path and a human-readable error message with a JSON Pointer path (e.g., `/rooms/0/name`). (maps to Req 8)
- [ ] **AC-8**: The `SceneDefinition` returned by `loadSceneFile` can be passed directly to `loadScene(core, scene)` without any adaptation layer or field renaming. (maps to Req 9)
- [ ] **AC-9**: After loading a scene file and calling auto-registration, all affordances listed in the YAML have registered `engineEffect` handlers in the `AffordanceRegistry`. Verified by checking `affordanceRegistry.hasHandler(effectId)` for every affordance in the scene. (maps to Req 10)
- [ ] **AC-10**: A custom `HandlerPlugin` registered for `objectType: 'custom_device'` provides handlers that are auto-registered when the loaded scene contains an object with `type: 'custom_device'`. (maps to Req 11)
- [ ] **AC-11**: When a room declares `connections: ['living_room']` but no doorway object exists in `objectIds`, the loader auto-generates a `doorway-<roomId>` smart object with a `go_to_living_room` affordance. The generated object appears in the returned `SceneDefinition.objects`. (maps to Req 12)
- [ ] **AC-12**: Running `npx evol-hive validate-scene examples/coffee-shop.scene.yaml` exits with code 0 and prints a success message. (maps to Req 15, Req 17)
- [ ] **AC-13**: Running `npx evol-hive validate-scene` on a malformed YAML file exits with code 1 and prints validation errors with field paths. (maps to Req 15)
- [ ] **AC-14**: Running `npx evol-hive create-scene` and answering the interactive prompts produces a `.scene.yaml` file that passes `validate-scene`. (maps to Req 14)
- [ ] **AC-15**: Running `npx evol-hive run-scene examples/coffee-shop.scene.yaml` builds the engine, starts the game loop, and prints at least one agent state snapshot before exiting. (maps to Req 16)
- [ ] **AC-16**: `examples/coffee-shop.scene.yaml` exists and is the declarative equivalent of the `COFFEE_SHOP_SCENE` in `examples/coffee-shop.ts` — same rooms, objects, and agents. (maps to Req 17)
- [ ] **AC-17**: All existing tests pass (`pnpm -r run test` exits 0) without modifying any existing test file. (maps to Req 18, Req 19)
- [ ] **AC-18**: The existing TypeScript example scenes (`coffee-shop.ts`, `minimal-scene.ts`, `morning-routine.ts`, `office-day.ts`) remain unmodified and their entry points still run. (maps to Req 18)
- [ ] **AC-19**: The `SceneDefinition` interface in `packages/shared/src/types/world.ts` is unchanged — no new required fields added, no existing fields removed. (maps to Req 18)

## Constraints

- **Package boundaries**: The JSON Schema lives in `@evol-hive/shared` (alongside existing types). The scene loader (`loadSceneFile`, auto-registration, plugin system) lives in `@evol-hive/engine`. The CLI lives in a new `packages/cli/` package (or root `bin/`) that depends on `engine`, `cognition`, `memory`, and `shared`. No new dependencies between `engine` and `cognition`.
- **YAML parsing**: Use `js-yaml` (mature, widely used) for YAML parsing. Add as a dependency to `@evol-hive/shared` or `@evol-hive/engine` only — not to `cognition` or `memory`.
- **JSON Schema validation**: Use `ajv` (Draft 2020-12 support) for runtime validation. Add as a dependency to the package that implements `loadSceneFile`.
- **CLI framework**: Use plain `readline` (Node.js built-in) or `@inquirer/prompts` for interactive prompts. Avoid heavy CLI frameworks (commander, yargs) — a simple `process.argv` switch is sufficient for three commands.
- **No LLM in validation**: `validate-scene` must not require an LLM connection. It is a pure schema-validation operation.
- **Affordance handler refactoring**: The handlers currently in `examples/scene-helpers.ts` are refactored into built-in `HandlerPlugin` instances within `@evol-hive/engine` (or a new `@evol-hive/scene-tools` package). The example files continue to import from the new location or retain their own copies for backward compat.
- **What NOT to do**:
  - Do not change the `SceneDefinition`, `SmartObject`, `Affordance`, or `AgentProfile` interfaces. The declarative format maps to existing types.
  - Do not add YAML/JSON parsing to the `cognition` or `memory` packages.
  - Do not invent a new scene format that diverges from the existing `SceneDefinition` structure. The YAML is a serialization of the same data model.
  - Do not require network access for `validate-scene` or `create-scene`.
  - Do not auto-register affordance handlers for object types that have no matching plugin — instead, log a warning and let the scene run (affordance execution will return `{ success: false, failureReason: 'No handler registered' }`).
