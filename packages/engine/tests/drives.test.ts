import { describe, it, expect } from 'vitest';
import type { AgentInternalState } from '@evol-hive/shared';
import { DriveSystemImpl } from '../src/agents/drives/index.js';

function makeAgent(drives: AgentInternalState['drives']): AgentInternalState {
  return {
    agentId: 'a1',
    drives,
    currentGoal: 'stay alive',
    currentPlan: null,
    isThinking: false,
    location: 'kitchen',
    lastPerceptionTick: 0,
  };
}

describe('DriveSystem.getPrimaryDrive (AC-3, AC-4)', () => {
  const driveSystem = new DriveSystemImpl();

  it('returns the drive with the LOWEST value as primary (0 = most urgent)', () => {
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

  it('returns hunger when hunger is lowest', () => {
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

describe('DriveSystem.getPrimaryDriveLabel (AC-3, AC-4)', () => {
  const driveSystem = new DriveSystemImpl();

  it('produces "low energy, need to restore energy"', () => {
    const state = makeAgent({
      energy: 10,
      hunger: 50,
      social: 80,
      comfort: 60,
      curiosity: 40,
    });
    expect(driveSystem.getPrimaryDriveLabel(state)).toBe('low energy, need to restore energy');
  });

  it('produces "low hunger, need to restore hunger"', () => {
    const state = makeAgent({
      energy: 90,
      hunger: 5,
      social: 70,
      comfort: 50,
      curiosity: 30,
    });
    expect(driveSystem.getPrimaryDriveLabel(state)).toBe('low hunger, need to restore hunger');
  });
});
