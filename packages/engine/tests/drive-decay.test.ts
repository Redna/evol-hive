/**
 * Tests for the DriveDecaySystem engine system.
 * Covers AC-7 (drive decay runs for all agents every tick, including thinking).
 */
import { describe, it, expect } from 'vitest';
import type { GameTick, AgentProfile } from '@evol-hive/shared';
import { AgentManagerImpl } from '../src/agents/state/index.js';
import { DriveSystemImpl } from '../src/agents/drives/index.js';
import { DriveDecaySystem } from '../src/systems/drive-decay.js';
import type { DriveSystem } from '../src/index.js';

const TICK: GameTick = { tickNumber: 1, simulationTime: 1, deltaSeconds: 0.5 };

function makeProfile(id: string, energy: number): AgentProfile {
  return {
    id,
    name: id,
    description: 'test',
    traits: [],
    initialDrives: { energy, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
  };
}

describe('DriveDecaySystem (AC-7, AC-20)', () => {
  it('applies drive decay to every active agent on every tick', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1', 50));
    agents.spawn(makeProfile('a2', 60));
    const driveSystem: DriveSystem = new DriveSystemImpl(agents);
    const sys = new DriveDecaySystem(agents, driveSystem);

    const e1Before = agents.getState('a1')!.drives.energy;
    const e2Before = agents.getState('a2')!.drives.energy;

    sys.update(TICK);

    expect(agents.getState('a1')!.drives.energy).toBeLessThan(e1Before);
    expect(agents.getState('a2')!.drives.energy).toBeLessThan(e2Before);
  });

  it('applies decay to agents with isThinking === true', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1', 50));
    agents.updateState('a1', { isThinking: true });
    const driveSystem: DriveSystem = new DriveSystemImpl(agents);
    const sys = new DriveDecaySystem(agents, driveSystem);

    const before = agents.getState('a1')!.drives.energy;
    sys.update(TICK);
    expect(agents.getState('a1')!.drives.energy).toBeLessThan(before);
    // isThinking untouched.
    expect(agents.getState('a1')!.isThinking).toBe(true);
  });

  it('uses the deltaSeconds from the tick', () => {
    const agents = new AgentManagerImpl();
    agents.spawn(makeProfile('a1', 100));
    const driveSystem: DriveSystem = new DriveSystemImpl(agents);
    const sys = new DriveDecaySystem(agents, driveSystem);

    sys.update({ tickNumber: 1, simulationTime: 1, deltaSeconds: 10 });
    // 100 - (10 * 0.1) = 99 (default decay rate 0.1)
    expect(agents.getState('a1')!.drives.energy).toBe(99);
  });

  it('has the name "drive-decay"', () => {
    const agents = new AgentManagerImpl();
    const driveSystem: DriveSystem = new DriveSystemImpl(agents);
    const sys = new DriveDecaySystem(agents, driveSystem);
    expect(sys.name).toBe('drive-decay');
  });
});
