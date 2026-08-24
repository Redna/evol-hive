/**
 * systems/auto-save — periodic fire-and-forget save system (spec 017, Req 16)
 * ───────────────────────────────────────────────────────────────────────────
 * An `EngineSystem` that auto-saves the game state every `intervalTicks`
 * engine ticks. The `update()` method is fully synchronous — it never awaits
 * the save promise. The save is fire-and-forget with `.catch()` error logging,
 * matching the `PPERScheduler` / `MemoryMaintenanceSystem` pattern. This
 * ensures the game loop is never blocked by serialization.
 *
 * Package boundaries (per ADR-0001 / spec 017, Req 20): imports only from
 * `@evol-hive/shared` (`AutoSaveConfig`, `GameTick`) and `@evol-hive/engine`
 * (`EnginePersistence`, `EngineSystem`). It does NOT import from
 * `@evol-hive/cognition` or `@evol-hive/memory`.
 */

import type { AutoSaveConfig, GameTick } from '@evol-hive/shared';
import type { EnginePersistence } from '../index.js';

/** Constructor options for {@link AutoSaveSystem} (spec 017, Req 16). */
export interface AutoSaveSystemOptions {
  persistence: EnginePersistence;
  config: AutoSaveConfig;
}

/**
 * Engine system that periodically auto-saves the game state. When
 * `config.enabled` is `false`, `update()` is a no-op. When enabled and
 * `config.filePath` is set, it calls `persistence.saveToFile(filePath)`; when
 * `filePath` is omitted, it calls `persistence.save()` (in-memory only). The
 * save is fire-and-forget — the game loop is never blocked.
 */
export class AutoSaveSystem {
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
    if (this.tickCounter % this.config.intervalTicks !== 0 || this.tickCounter === 0) return;

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

export {};
