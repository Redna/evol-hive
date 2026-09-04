/**
 * world/mutations/ — Runtime scene mutation (spec 030 — Dynamic Scenes / Living Worlds)
 * ───────────────────────────────────────────────────────────────────────────────────────
 * The single entry point for runtime structural changes: `SceneMutationService`
 * (propose → validate → queue → apply at tick boundary), the append-only
 * mutation event log, the `DormantAgentStore` for despawn/respawn, the YAAM
 * event log for cross-session agent persistence, and the tick-boundary
 * `SceneMutationSystem`.
 */

export { SceneMutationServiceImpl } from './scene-mutation-service.js';
export type {
  SceneMutationServiceOptions,
  DormancyMemoryPort,
} from './scene-mutation-service.js';
export { DormantAgentStore } from './dormant-agent-store.js';
export { YaamEventLog, agentStateLabel, agentMemoryLabel } from './yaam-event-log.js';
export type { YaamEvent, YaamReplayedNode } from './yaam-event-log.js';
export { SceneMutationSystem } from './mutation-system.js';