// drives/ — Drive decay, modification, and primary drive detection
// ─────────────────────────────────────────────────────────────────
// Section 3: Drives are 0-100 values where lower = more urgent.
// The primary drive (lowest value) feeds into the System 0 Classifier.

import type { AgentInternalState } from '@evol-hive/shared';
import type { DriveSystem } from '../index.js';

/**
 * In-memory implementation of `DriveSystem`.
 * Primary drive = lowest value (0 = most urgent, per §3 and YAAM design decision).
 */
export class DriveSystemImpl implements DriveSystem {
  applyDecay(state: AgentInternalState, deltaSeconds: number): void {
    // Simple linear decay: each drive decreases by decayRate * deltaSeconds.
    // Implementation deferred — only the primary drive detection is in scope for spec 001.
    const decayRate = 0.1; // per second
    const { drives } = state;
    drives.energy = Math.max(0, drives.energy - decayRate * deltaSeconds);
    drives.hunger = Math.max(0, drives.hunger - decayRate * deltaSeconds);
    drives.social = Math.max(0, drives.social - decayRate * deltaSeconds);
    drives.comfort = Math.max(0, drives.comfort - decayRate * deltaSeconds);
    drives.curiosity = Math.max(0, drives.curiosity - decayRate * deltaSeconds);
  }

  applyChanges(agentId: string, _changes: Partial<Record<string, number>>): void {
    // Apply drive changes from an affordance result.
    // Requires an agent state store — deferred to a later spec.
    // Intentionally a no-op for now; the interface is defined for future use.
    void agentId;
  }

  /**
   * Get the agent's primary drive — the drive with the LOWEST value.
   * (0 = most urgent, per §3 and YAAM design decision note-1.)
   */
  getPrimaryDrive(state: AgentInternalState): { name: string; value: number } {
    const { drives } = state;
    const entries: { name: string; value: number }[] = [
      { name: 'energy', value: drives.energy },
      { name: 'hunger', value: drives.hunger },
      { name: 'social', value: drives.social },
      { name: 'comfort', value: drives.comfort },
      { name: 'curiosity', value: drives.curiosity },
    ];

    let primary = entries[0]!;
    for (const entry of entries) {
      if (entry.value < primary.value) {
        primary = entry;
      }
    }
    return primary;
  }

  /**
   * Get the semantic label for the primary drive.
   * Format: "low {drive}, need to restore {drive}"
   * (AC-3, AC-4)
   */
  getPrimaryDriveLabel(state: AgentInternalState): string {
    const primary = this.getPrimaryDrive(state);
    return `low ${primary.name}, need to restore ${primary.name}`;
  }
}
