/**
 * systems/auto-save — periodic auto-save engine system (spec 017, Req 16)
 * ─────────────────────────────────────────────────────────────────────────────
 * An `EngineSystem` that fire-and-forgets a save operation every
 * `intervalTicks` ticks. The `update()` method is fully synchronous — it never
 * awaits the save promise (matching the `PPERScheduler` / `MemoryMaintenanceSystem`
 * pattern). Errors are logged via `.catch()`.
 *
 * Imports from `@evol-hive/shared` and `@evol-hive/engine` only — never from
 * `@evol-hive/cognition` or `@evol-hive/memory` (per ADR-0001, Req 20).
 */

import type { GameTick, AutoSaveConfig } from '@evol-hive/shared';
import type { EnginePersistence, EngineSystem } from '../index.js';

/** Constructor options for {@link AutoSaveSystem}. */
export interface AutoSaveSystemOptions {
  persistence: EnginePersistence;
  config: AutoSaveConfig;
}

/**
 * EngineSystem that periodically fire-and-forgets a save operation. When
 * `config.filePath` is set, saves are written to disk; otherwise an in-memory
 * `save()` is called.
 */
export class AutoSaveSystem implements EngineSystem {
  readonly name = 'auto-save';

  private readonly persistence: EnginePersistence;
  private readonly config: AutoSaveConfig;
  private tickCounter = 0;

  constructor(options: AutoSaveSystemOptions) {
    this.persistence = options.persistence;
    this.config = options.config;
  }

  /** Called every tick by the game loop. Synchronous — never awaits. */
  update(_tick: GameTick): void {
    if (!this.config.enabled) return;

    this.tickCounter += 1;

    if (this.tickCounter > 0 && this.tickCounter % this.config.intervalTicks === 0) {
      if (this.config.filePath !== undefined) {
        this.persistence.saveToFile(this.config.filePath).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[AutoSaveSystem] saveToFile failed: ${message}`);
        });
      } else {
        this.persistence.save().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[AutoSaveSystem] save failed: ${message}`);
        });
      }
    }
  }
}

export {};
