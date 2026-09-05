/**
 * systems/conversation-lifecycle — Conversation lifecycle tick (spec 033, R2/R7)
 * ────────────────────────────────────────────────────────────────────────────
 * A thin `EngineSystem` that sweeps conversations each tick: closes idle
 * conversations (R2 idle timeout) and removes participants who wandered out
 * of the conversation's room (R7 — wandering off = leaving the conversation,
 * the lifecycle twin of the spec-031 co-location guard). Also drives
 * close-time per-participant `interaction` memory consolidation (R5).
 */

import type { GameTick } from '@evol-hive/shared';
import type { EngineSystem } from '../index.js';
import type { ConversationManagerImpl } from '../social/conversation-manager.js';

/** Tick-driven conversation lifecycle sweep (spec 033, R2/R7). */
export class ConversationLifecycleSystem implements EngineSystem {
  readonly name = 'conversation-lifecycle';

  constructor(private readonly conversationManager: ConversationManagerImpl) {}

  update(tick: GameTick): void {
    this.conversationManager.tick(tick.tickNumber);
  }
}

export {};
