/**
 * drives/ — Drive decay, modification, and primary drive detection
 * ─────────────────────────────────────────────────────────────────
 * Section 3: Drives are 0-100 where 0 = most urgent. The primary drive is the
 * one with the LOWEST value; its semantic label feeds the System 0 classifier.
 */

import type { AgentInternalState } from '@evol-hive/shared';
import type { AgentManager, DriveSystem } from '../index.js';

/** The five primary drives, in canonical order. */
const DRIVE_KEYS = ['energy', 'hunger', 'social', 'comfort', 'curiosity'] as const;

/** Concrete DriveSystem. Optionally wired to an AgentManager for `applyChanges`. */
export class DriveSystemImpl implements DriveSystem {
  constructor(private readonly agentManager?: AgentManager) {}

  /** Apply natural drive decay over a time delta (mutates `state.drives` in place). */
  applyDecay(state: AgentInternalState, deltaSeconds: number): void {
    for (const key of DRIVE_KEYS) {
      const current = state.drives[key];
      state.drives[key] = clampDrive(current - deltaSeconds);
    }
  }

  /** Apply drive changes from an affordance result. */
  applyChanges(agentId: string, changes: Partial<Record<string, number>>): void {
    const state = this.agentManager?.getState(agentId);
    if (!state) return;
    for (const [key, delta] of Object.entries(changes)) {
      if (isDriveKey(key)) {
        state.drives[key] = clampDrive(state.drives[key] + (delta ?? 0));
      }
    }
  }

  /** The agent's primary drive = the drive with the lowest value (0 = most urgent). */
  getPrimaryDrive(state: AgentInternalState): { name: string; value: number } {
    let name: (typeof DRIVE_KEYS)[number] = DRIVE_KEYS[0];
    let value = state.drives[name];
    for (const key of DRIVE_KEYS) {
      if (state.drives[key] < value) {
        name = key;
        value = state.drives[key];
      }
    }
    return { name, value };
  }

  /** Semantic label for the primary drive, e.g. "low energy, need to restore energy". */
  getPrimaryDriveLabel(state: AgentInternalState): string {
    const { name } = this.getPrimaryDrive(state);
    return `low ${name}, need to restore ${name}`;
  }
}

function isDriveKey(key: string): key is (typeof DRIVE_KEYS)[number] {
  return (DRIVE_KEYS as readonly string[]).includes(key);
}

function clampDrive(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export {};
