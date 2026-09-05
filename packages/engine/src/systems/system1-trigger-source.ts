/**
 * systems/system1-trigger-source — Engine-state hard-trigger extraction
 * (spec 035, Req 1, Req 5)
 * ────────────────────────────────────────────────────────────────────────────
 * Reads ONLY engine state (peeked message queue, conversation objects,
 * mutation log, tracker drive snapshots) and produces the `HardTriggerFlags`
 * handed to the System 1 gate. Peeking never consumes: a gated-idle tick must
 * not eat a pending message (the Perceive phase dequeues it when a cycle
 * actually runs).
 *
 * Hard triggers (Req 5 — the gate runs, but these force a cycle):
 *   - incoming agent message pending
 *   - conversation invite (a live conversation the agent may join) — and a
 *     live conversation the agent participates in (conversation turns are a
 *     hard trigger; cycles are never suppressed during conversations)
 *   - nearby object mutation (mutation in the agent's current room since its
 *     last completed cycle)
 *   - drive threshold crossing since the last completed cycle
 */

import type {
  AddObjectPayload,
  HardTriggerFlags,
  MoveObjectPayload,
  SceneMutationEvent,
  SetConnectionStatePayload,
  SpawnAgentPayload,
  System1TriggerSourcePort,
} from '@evol-hive/shared';
import { NO_HARD_TRIGGERS, detectThresholdCrossings, DEFAULT_DRIVE_THRESHOLDS } from '@evol-hive/shared';
import type { DriveThresholds } from '@evol-hive/shared';
import type { AgentManager } from '../agents/index.js';
import type { SocialManager } from '../social/social-manager.js';
import type { ConversationManagerImpl } from '../social/conversation-manager.js';
import type { SceneMutationPort } from '@evol-hive/shared';
import type { System1AgentTracker } from './system1-agent-tracker.js';

/** Constructor options for {@link System1TriggerSourceImpl}. All sources are
 * optional — missing sources simply never fire (fail-open toward cycling). */
export interface System1TriggerSourceOptions {
  agentManager: AgentManager;
  socialManager?: SocialManager;
  conversationManager?: ConversationManagerImpl;
  mutationPort?: SceneMutationPort;
  tracker: System1AgentTracker;
  /** Drive thresholds for crossing detection (default 20/80). */
  driveThresholds?: DriveThresholds;
}

export class System1TriggerSourceImpl implements System1TriggerSourcePort {
  private readonly agentManager: AgentManager;
  private readonly socialManager: SocialManager | undefined;
  private readonly conversationManager: ConversationManagerImpl | undefined;
  private readonly mutationPort: SceneMutationPort | undefined;
  private readonly tracker: System1AgentTracker;
  private readonly thresholds: DriveThresholds;

  constructor(options: System1TriggerSourceOptions) {
    this.agentManager = options.agentManager;
    this.socialManager = options.socialManager;
    this.conversationManager = options.conversationManager;
    this.mutationPort = options.mutationPort;
    this.tracker = options.tracker;
    this.thresholds = options.driveThresholds ?? DEFAULT_DRIVE_THRESHOLDS;
  }

  getHardTriggers(agentId: string): HardTriggerFlags {
    const state = this.agentManager.getState(agentId);
    if (!state) return { ...NO_HARD_TRIGGERS };

    // (1) Incoming message pending — PEEK, never consume (Req 5).
    const messagePending = (this.socialManager?.peekPendingMessages(agentId) ?? 0) > 0;

    // (2) Conversation activity (Req 5 + constraint "never suppress cycles
    // during conversations"): the agent participates in a live conversation
    // (its turns are a hard trigger) OR an open conversation in its room is
    // an invitation it may join. Both fold into `conversationInvite`.
    let conversationInvite = false;
    const conversations = this.conversationManager;
    if (conversations && state.location) {
      for (const conversation of conversations.listConversationsInRoom(state.location)) {
        if (conversation.status === 'closed') continue;
        if (conversation.participants.some((p) => p.agentId === agentId)) {
          conversationInvite = true; // active participant — turns are a hard trigger
        } else if (conversation.status === 'open') {
          conversationInvite = true; // an invitation the agent may join
        }
      }
    }

    // (3) Nearby object mutation — in the agent's CURRENT room, since its
    // last completed cycle (the tracker pins the seen mutation seq).
    let nearbyObjectMutation = false;
    const mutations = this.mutationPort;
    if (mutations && state.location) {
      const sinceSeq = this.tracker.getLastMutationSeq(agentId);
      const recent = mutations.getMutations(sinceSeq || undefined);
      nearbyObjectMutation = recent.some((m) => mutationRooms(m).includes(state.location));
    }

    // (4) Drive threshold crossing — drives now vs. at the last completed
    // cycle (pure shared contract function, Req 2).
    let driveThresholdCrossing = false;
    const drivesAtLastCycle = this.tracker.getDrivesAtLastCycle(agentId);
    if (drivesAtLastCycle) {
      driveThresholdCrossing = detectThresholdCrossings(
        drivesAtLastCycle,
        state.drives,
        this.thresholds,
      );
    }

    return {
      messagePending,
      conversationInvite,
      nearbyObjectMutation,
      driveThresholdCrossing,
    };
  }

  /**
   * Conversation context for the scalar features (Req 1): participation +
   * turn count of the agent's live conversation (0 when none).
   */
  getConversationContext(agentId: string): { open: boolean; turns: number } {
    const state = this.agentManager.getState(agentId);
    const conversations = this.conversationManager;
    if (!state || !conversations || !state.location) return { open: false, turns: 0 };
    let open = false;
    let turns = 0;
    for (const conversation of conversations.listConversationsInRoom(state.location)) {
      if (conversation.status === 'closed') continue;
      const me = conversation.participants.find((p) => p.agentId === agentId);
      if (me) {
        open = true;
        turns = Math.max(turns, me.turnCount);
      }
    }
    return { open, turns };
  }
}

/**
 * Derives the room(s) a mutation touched (spec 035 Req 1: "nearby object
 * state changes" from engine state alone). `remove_object` carries no room —
 * it affects no specific room for proximity purposes.
 */
function mutationRooms(event: SceneMutationEvent): string[] {
  switch (event.type) {
    // The event is a single interface (type ↔ payload are not a discriminated
    // union), so each case narrows the payload explicitly.
    case 'add_object':
      return [(event.payload as AddObjectPayload).object.roomId];
    case 'move_object':
      return [(event.payload as MoveObjectPayload).toRoomId];
    case 'set_connection_state':
      return [
        (event.payload as SetConnectionStatePayload).roomA,
        (event.payload as SetConnectionStatePayload).roomB,
      ];
    case 'spawn_agent': {
      const profile = (event.payload as SpawnAgentPayload).profile;
      return profile?.startRoomId ? [profile.startRoomId] : [];
    }
    default:
      return [];
  }
}