/**
 * Spec 062 — Visualizer World View (1/2) — pure layout seam.
 *
 * Covers the ACs that are assertable as DATA thanks to the `layoutWorld` seam
 * (spec 062, Decision 2): topology-aware placement (AC-1), viewport/inset fit
 * (AC-2), doorway promotion + one door per connection (AC-3), the
 * frame-rate-independent smoother (AC-4), and skin independence (AC-5).
 */

import { describe, it, expect } from 'vitest';
import type { VisualizerRoom, VisualizerState } from '@evol-hive/shared';
import {
  layoutWorld,
  placeRooms,
  adjacencyScore,
  smoothTowards,
  GRID_COLS,
  GRID_ROWS,
  ZERO_INSETS,
} from '../src/renderer/layout.js';
import type { Insets, Point, Rect, Viewport } from '../src/renderer/layout.js';
import { CanvasRenderer } from '../src/renderer/canvas-renderer.js';
import type { Skin } from '../src/renderer/skin.js';

/** Coffee-shop topology (examples/coffee-shop.scene.yaml): 4 unique
 *  connections. `living_room` is connected to all three others, but a 2×2
 *  corner cell has only two neighbours, so at most 3 edges can be adjacent —
 *  one connection MUST become a routed corridor. The old insertion-order grid
 *  put two of them on the diagonal (the centre-to-centre "giant X"). */
function coffeeShopRooms(): VisualizerRoom[] {
  return [
    {
      id: 'kitchen',
      name: 'Kitchen',
      description: '',
      connections: ['living_room', 'garden'],
      objects: [],
    },
    {
      id: 'living_room',
      name: 'Living Room',
      description: '',
      connections: ['kitchen', 'bathroom', 'garden'],
      objects: [],
    },
    {
      id: 'bathroom',
      name: 'Bathroom',
      description: '',
      connections: ['living_room'],
      objects: [],
    },
    {
      id: 'garden',
      name: 'Garden',
      description: '',
      connections: ['living_room', 'kitchen'],
      objects: [],
    },
  ];
}

function stateWith(rooms: VisualizerRoom[]): VisualizerState {
  return {
    tickNumber: 0,
    simulationTime: 0,
    isRunning: false,
    timeScale: 1,
    rooms,
    agents: [],
  } as unknown as VisualizerState;
}

const VIEWPORT: Viewport = { width: 1280, height: 720, insets: ZERO_INSETS };

function insideStrict(p: Point, rect: Rect, pad: number): boolean {
  return (
    p.x > rect.x + pad &&
    p.x < rect.x + rect.w - pad &&
    p.y > rect.y + pad &&
    p.y < rect.y + rect.h - pad
  );
}

describe('layoutWorld — topology-aware placement (spec 062, AC-1)', () => {
  it('places coffee-shop rooms so most connections are edge-adjacent', () => {
    const rooms = coffeeShopRooms();
    const layout = layoutWorld(stateWith(rooms), VIEWPORT);
    expect(layout.rooms).toHaveLength(4);
    // The 2×2 grid has 4 edges, but living_room (degree 3) can only be
    // edge-adjacent to two of its neighbours, so 3 adjacent + 1 corridor is
    // the optimum. The old insertion-order layout produced TWO diagonals.
    const openings = layout.doors.filter((d) => d.kind === 'opening').length;
    const corridors = layout.doors.filter((d) => d.kind === 'corridor').length;
    expect(openings).toBe(3);
    expect(corridors).toBe(1);
    // Exactly one door per unique connection.
    expect(layout.doors).toHaveLength(4);
  });

  it('routes the non-adjacent connection through the gutters, never across a room', () => {
    const layout = layoutWorld(stateWith(coffeeShopRooms()), VIEWPORT);
    const corridors = layout.doors.filter((d) => d.kind === 'corridor');
    expect(corridors).toHaveLength(1);
    const points = corridors[0]!.points;
    expect(points.length).toBeGreaterThanOrEqual(2);
    // Sample every corridor segment; no sample may fall strictly inside a room.
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      for (let s = 0; s <= 20; s++) {
        const t = s / 20;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        for (const room of layout.rooms) {
          expect(
            insideStrict(p, room.rect, 2),
            `corridor crosses ${room.roomId} at ${JSON.stringify(p)}`,
          ).toBe(false);
        }
      }
    }
  });

  it('scores placement by adjacency and prefers a topology-preserving grid', () => {
    const rooms = coffeeShopRooms();
    const grid = placeRooms(rooms, 2, 2);
    expect(grid.size).toBe(4);
    expect(adjacencyScore(rooms, grid)).toBe(3);
  });
});

describe('layoutWorld — viewport and inset fit (spec 062, AC-2)', () => {
  const cases: { w: number; h: number; insets: Insets }[] = [
    { w: 360, h: 640, insets: { top: 56, right: 0, bottom: 96, left: 0 } },
    { w: 390, h: 844, insets: { top: 48, right: 0, bottom: 88, left: 0 } },
    { w: 1280, h: 720, insets: { top: 44, right: 0, bottom: 72, left: 0 } },
  ];

  for (const { w, h, insets } of cases) {
    it(`keeps every room inside the ${w}×${h} viewport clear of the HUD`, () => {
      const layout = layoutWorld(stateWith(coffeeShopRooms()), {
        width: w,
        height: h,
        insets,
      });
      for (const room of layout.rooms) {
        expect(room.rect.x).toBeGreaterThanOrEqual(insets.left - 0.01);
        expect(room.rect.y).toBeGreaterThanOrEqual(insets.top - 0.01);
        expect(room.rect.x + room.rect.w).toBeLessThanOrEqual(w - insets.right + 0.01);
        expect(room.rect.y + room.rect.h).toBeLessThanOrEqual(h - insets.bottom + 0.01);
        expect(room.rect.w).toBeGreaterThan(0);
        expect(room.rect.h).toBeGreaterThan(0);
      }
    });
  }

  it('never exceeds the cell the viewport allows (no desktop overflow)', () => {
    // Regression: an asymmetric aspect clamp once forced rooms larger than the
    // available cell, pushing the grid off-screen on desktop.
    const layout = layoutWorld(stateWith(coffeeShopRooms()), {
      width: 1280,
      height: 720,
      insets: ZERO_INSETS,
    });
    const cols = layout.columns;
    const rows = layout.rows;
    expect(cols * rows).toBeGreaterThanOrEqual(layout.rooms.length);
    for (const room of layout.rooms) {
      expect(room.rect.x + room.rect.w).toBeLessThanOrEqual(1280 + 0.01);
      expect(room.rect.y + room.rect.h).toBeLessThanOrEqual(720 + 0.01);
    }
  });
});

describe('layoutWorld — doorways are doors, not chips (spec 062, AC-3)', () => {
  it('excludes type:"doorway" from objects and derives doors from connections', () => {
    const rooms: VisualizerRoom[] = [
      {
        id: 'kitchen',
        name: 'Kitchen',
        description: '',
        connections: ['garden'],
        objects: [
          {
            id: 'doorway-kitchen',
            name: 'Doorway',
            type: 'doorway',
            state: {},
            affordances: [{ id: 'go_to_garden', label: 'Go to garden' }],
          },
          {
            id: 'coffee-1',
            name: 'Coffee Machine',
            type: 'appliance',
            state: { water_level: 5 },
            cell: { x: 2, y: 2 },
            affordances: [],
          },
        ],
      },
      { id: 'garden', name: 'Garden', description: '', connections: ['kitchen'], objects: [] },
    ];
    const layout = layoutWorld(stateWith(rooms), VIEWPORT);
    expect(layout.objects.map((o) => o.id)).not.toContain('doorway-kitchen');
    expect(layout.objects.map((o) => o.id)).toContain('coffee-1');
    expect(layout.doors).toHaveLength(1);
    // The doorway object's `go_to_<room>` affordance agrees with the connection.
    const doorway = rooms[0]!.objects.find((o) => o.type === 'doorway');
    const targets = (doorway?.affordances ?? []).map((a) => a.id.replace(/^go_to_/, '')).sort();
    expect(targets).toEqual([...rooms[0]!.connections].sort());
  });
});

describe('smoothTowards — frame-rate-independent glide (spec 062, AC-4)', () => {
  it('approaches the target monotonically without overshoot', () => {
    let v = 0;
    const target = 100;
    let prev = v;
    for (let i = 0; i < 200; i++) {
      v = smoothTowards(v, target, 1 / 60, 0.09);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(target);
      prev = v;
    }
    expect(v).toBeCloseTo(target, 1);
  });

  it('is partition-independent: one 0.1s step equals two 0.05s steps', () => {
    const one = smoothTowards(0, 100, 0.1, 0.09);
    const two = smoothTowards(smoothTowards(0, 100, 0.05, 0.09), 100, 0.05, 0.09);
    expect(two).toBeCloseTo(one, 10);
  });

  it('snaps to the target when the half-life is zero', () => {
    expect(smoothTowards(3, 42, 0.016, 0)).toBe(42);
  });

  it('is a no-op once at the target', () => {
    expect(smoothTowards(42, 42, 0.016, 0.09)).toBe(42);
  });
});

describe('renderer skin seam (spec 062, AC-5)', () => {
  it('dispatches drawing to an injected skin and keeps layout skin-independent', () => {
    const called: string[] = [];
    const noop = (): void => {};
    const recording: Skin = {
      drawBackground: () => called.push('background'),
      drawRoom: () => called.push('room'),
      drawCorridor: noop,
      drawDoorOpening: () => called.push('door'),
      drawObject: noop,
      drawAgent: () => called.push('agent'),
      drawRelationship: noop,
      drawStatus: () => called.push('status'),
    };
    const ctx = {
      canvas: { width: 800, height: 600 },
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: 'left',
      textBaseline: 'top',
    } as unknown as CanvasRenderingContext2D;
    const state = stateWith([
      { id: 'kitchen', name: 'Kitchen', description: '', connections: [], objects: [] },
    ]);
    const renderer = new CanvasRenderer(ctx, recording);
    renderer.render(state);
    expect(called).toContain('background');
    expect(called).toContain('room');
    expect(called).toContain('status');
    // layoutWorld takes no skin, so two calls are deep-equal by construction.
    const a = layoutWorld(state, { width: 800, height: 600, insets: ZERO_INSETS });
    const b = layoutWorld(state, { width: 800, height: 600, insets: ZERO_INSETS });
    expect(a).toEqual(b);
  });
});

describe('layoutWorld — cell-less (legacy) objects (spec 038 legacy path)', () => {
  const legacyRoom: VisualizerRoom = {
    id: 'kitchen',
    name: 'Kitchen',
    description: '',
    connections: [],
    objects: [
      { id: 'a', name: 'Coffee Machine', type: 'appliance', state: {}, affordances: [] },
      { id: 'b', name: 'Sink', type: 'fixture', state: {}, affordances: [] },
    ],
  };

  it('gives objects with no grid cell distinct slots (they must not stack)', () => {
    const layout = layoutWorld(stateWith([legacyRoom]), VIEWPORT);
    expect(layout.objects).toHaveLength(2);
    expect(layout.objects[0]!.x).not.toBe(layout.objects[1]!.x);
    expect(layout.objects.every((o) => o.visible)).toBe(true);
  });

  it('never fog-hides a cell-less object (spec 039 R8 legacy rule)', () => {
    const state = {
      ...stateWith([legacyRoom]),
      agents: [
        {
          agentId: 'a1',
          name: 'Alice',
          location: 'kitchen',
          drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
          currentGoal: '',
          currentPlan: null,
          pperPhase: 'perceive',
          isThinking: false,
          relationships: [],
          fog: { visitedRooms: [], exploredCells: {} },
        },
      ],
    } as unknown as VisualizerState;
    const layout = layoutWorld(state, VIEWPORT);
    expect(layout.objects.map((o) => o.visible)).toEqual([true, true]);
  });
});

describe('layout constants', () => {
  it('matches the engine RoomGrid dimensions (spec 038)', () => {
    expect(GRID_COLS).toBe(12);
    expect(GRID_ROWS).toBe(8);
  });
});
