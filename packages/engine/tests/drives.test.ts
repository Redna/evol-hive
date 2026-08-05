import { describe, it, expect } from 'vitest';
import type { AgentInternalState } from '@evol-hive/shared';
import { DriveSystemImpl } from '../src/agents/drives/index.js';

// AC-3: Given drives { energy: 10, hunger: 50, social: 80, comfort: 60, curiosity: 40 },
//        the primary drive is energy and the label is "low energy, need to restore energy".
// AC-4: Given drives { energy: 90, hunger: 5, social: 70, comfort: 50, curiosity: 30 },
//        the primary drive is hunger and the label is "low hunger, need to restore hunger".

function makeAgent(drives: AgentInternalState['drives']): AgentInternalState {
  return {
    agentId: 'agent-1',
    drives,
    currentGoal: 'survive',
    currentPlan: null,
    isThinking: false,
    location: 'kitchen',
    lastPerceptionTick: 0,
  };
}

describe('DriveSystemImpl', () => {
  const driveSystem = new DriveSystemImpl();

  describe('getPrimaryDrive', () => {
    it('returns the drive with the lowest value (0 = most urgent) — AC-3', () => {
      const state = makeAgent({
        energy: 10,
        hunger: 50,
        social: 80,
        comfort: 60,
        curiosity: 40,
      });

      const primary = driveSystem.getPrimaryDrive(state);

      expect(primary.name).toBe('energy');
      expect(primary.value).toBe(10);
    });

    it('returns the drive with the lowest value — AC-4', () => {
      const state = makeAgent({
        energy: 90,
        hunger: 5,
        social: 70,
        comfort: 50,
        curiosity: 30,
      });

      const primary = driveSystem.getPrimaryDrive(state);

      expect(primary.name).toBe('hunger');
      expect(primary.value).toBe(5);
    });
  });

  describe('getPrimaryDriveLabel', () => {
    it('produces "low energy, need to restore energy" — AC-3', () => {
      const state = makeAgent({
        energy: 10,
        hunger: 50,
        social: 80,
        comfort: 60,
        curiosity: 40,
      });

      const label = driveSystem.getPrimaryDriveLabel(state);

      expect(label).toBe('low energy, need to restore energy');
    });

    it('produces "low hunger, need to restore hunger" — AC-4', () => {
      const state = makeAgent({
        energy: 90,
        hunger: 5,
        social: 70,
        comfort: 50,
        curiosity: 30,
      });

      const label = driveSystem.getPrimaryDriveLabel(state);

      expect(label).toBe('low hunger, need to restore hunger');
    });
  });
});
