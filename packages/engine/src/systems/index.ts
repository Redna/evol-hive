/**
 * systems/ — Engine systems (per-tick `EngineSystem` implementations)
 */

export { DriveDecaySystem } from './drive-decay.js';
export { PPERScheduler, type System1SchedulerPorts } from './pper-scheduler.js';
export { MemoryMaintenanceSystem, type MemoryMaintenanceOptions } from './memory-maintenance.js';
export { ObjectStateSystem } from './object-state.js';
export { AutoSaveSystem, type AutoSaveSystemOptions } from './auto-save.js';
export { ConversationLifecycleSystem } from './conversation-lifecycle.js';

// System 1 trainable heads (spec 035)
export { System1AgentTracker } from './system1-agent-tracker.js';
export {
  System1TriggerSourceImpl,
  type System1TriggerSourceOptions,
} from './system1-trigger-source.js';
export {
  System1OutcomeRecorderImpl,
  type System1OutcomeRecorderOptions,
} from './system1-outcome-recorder.js';
export {
  System1FeatureSystem,
  type System1FeatureSystemOptions,
} from './system1-feature-system.js';
export {
  System1IdentityTriggerSystem,
  type System1IdentityTriggerOptions,
} from './system1-identity-trigger.js';