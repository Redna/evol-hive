/**
 * Spec 063 — Visualizer Mobile Shell (2/2) — pure camera seam.
 *
 * AC-3 (centring + clamping + identity), AC-4 (frame-rate-independent pan is
 * covered by smoothTowards in renderer-layout.test.ts), and the geometry
 * transform that lets the renderer apply a camera without a 2D-context
 * transform.
 */

import { describe, it, expect } from 'vitest';
import type { VisualizerRoom, VisualizerState } from '@evol-hive/shared';
import { layoutWorld, ZERO_INSETS } from '../src/renderer/layout.js';
import type { Viewport } from '../src/renderer/layout.js';
import {
  FIT_ALL_CAMERA,
  FOLLOW_SCALE,
  cameraFor,
  transformLayout,
  worldBounds,
} from '../src/renderer/camera.js';

function rooms(): VisualizerRoom[] {
  return [
    { id: 'kitchen', name: 'Kitchen', description: '', connections: ['garden'], objects: [] },
    { id: 'garden', name: 'Garden', description: '', connections: ['kitchen'], objects: [] },
  ];
}

function state(agent?: { x: number; y: number }): VisualizerState {
  return {
    tickNumber: 0,
    simulationTime: 0,
    isRunning: false,
    timeScale: 1,
    rooms: rooms(),
    agents: [
      {
        agentId: 'a1',
        name: 'Alice',
        location: 'kitchen',
        ...(agent !== undefined ? { position: agent } : {}),
        drives: { energy: 50, hunger: 50, social: 50, comfort: 50, curiosity: 50 },
        currentGoal: '',
        currentPlan: null,
        pperPhase: 'perceive',
        isThinking: false,
        relationships: [],
      },
    ],
  } as unknown as VisualizerState;
}

const VIEWPORT: Viewport = { width: 800, height: 600, insets: ZERO_INSETS };
const SMALL: Viewport = { width: 240, height: 220, insets: ZERO_INSETS };
describe('cameraFor — selection, centring, clamping (spec 063, AC-3)', () => {
  it('returns the fit-all view when nothing is selected', () => {
    const layout = layoutWorld(state({ x: 3, y: 3 }), VIEWPORT);
    expect(cameraFor(null, layout)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(FIT_ALL_CAMERA).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  it('falls back to fit-all for an unknown agent id', () => {
    const layout = layoutWorld(state({ x: 3, y: 3 }), VIEWPORT);
    expect(cameraFor('nope', layout)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  it('centres the selected agent in the viewport when the clamp allows it', () => {
    // Cell (11,4) sits right-of-centre in the kitchen; with the follow scale
    // the required offset is inside the clamp range, so the agent centrelines.
    // (A cell left of centre would need a positive offset, which the clamp
    // correctly refuses — that is the next test.)
    const layout = layoutWorld(state({ x: 11, y: 4 }), VIEWPORT);
    const agent = layout.agents[0]!;
    const camera = cameraFor('a1', layout);
    expect(camera.scale).toBe(FOLLOW_SCALE);
    expect(agent.x * camera.scale + camera.offsetX).toBeCloseTo(VIEWPORT.width / 2, 6);
    expect(agent.y * camera.scale + camera.offsetY).toBeCloseTo(VIEWPORT.height / 2, 6);
  });

  it('clamps so the viewport never shows past the world bounds', () => {
    const layout = layoutWorld(state({ x: 0, y: 0 }), VIEWPORT);
    const camera = cameraFor('a1', layout);
    const bounds = worldBounds(layout);
    // World edges must stay outside (>=) the viewport edges, at the follow scale.
    expect(bounds.x * camera.scale + camera.offsetX).toBeLessThanOrEqual(0.001);
    expect(bounds.y * camera.scale + camera.offsetY).toBeLessThanOrEqual(0.001);
    expect((bounds.x + bounds.w) * camera.scale + camera.offsetX).toBeGreaterThanOrEqual(
      VIEWPORT.width - 0.001,
    );
    expect((bounds.y + bounds.h) * camera.scale + camera.offsetY).toBeGreaterThanOrEqual(
      VIEWPORT.height - 0.001,
    );
  });

  it('is deterministic: equal inputs give deep-equal cameras', () => {
    const layout = layoutWorld(state({ x: 5, y: 2 }), SMALL);
    expect(cameraFor('a1', layout)).toEqual(cameraFor('a1', layout));
  });
});
describe('transformLayout — geometry-only camera application (spec 063)', () => {
  it('returns the input unchanged for the identity camera', () => {
    const layout = layoutWorld(state({ x: 3, y: 3 }), VIEWPORT);
    expect(transformLayout(layout, FIT_ALL_CAMERA)).toBe(layout);
  });

  it('translates rooms, agents and objects by the camera offset', () => {
    const layout = layoutWorld(state({ x: 3, y: 3 }), VIEWPORT);
    const camera = { scale: 1, offsetX: 25, offsetY: -40 };
    const moved = transformLayout(layout, camera);
    expect(moved.rooms[0]!.rect.x).toBeCloseTo(layout.rooms[0]!.rect.x + 25, 6);
    expect(moved.rooms[0]!.rect.y).toBeCloseTo(layout.rooms[0]!.rect.y - 40, 6);
    expect(moved.agents[0]!.x).toBeCloseTo(layout.agents[0]!.x + 25, 6);
    expect(moved.agents[0]!.y).toBeCloseTo(layout.agents[0]!.y - 40, 6);
  });

  it('does not mutate the input layout', () => {
    const layout = layoutWorld(state({ x: 3, y: 3 }), VIEWPORT);
    const before = JSON.stringify(layout);
    transformLayout(layout, { scale: 1.5, offsetX: 10, offsetY: 10 });
    expect(JSON.stringify(layout)).toBe(before);
  });

  it('scales room size when the camera zooms', () => {
    const layout = layoutWorld(state({ x: 3, y: 3 }), VIEWPORT);
    const moved = transformLayout(layout, { scale: 2, offsetX: 0, offsetY: 0 });
    expect(moved.rooms[0]!.rect.w).toBeCloseTo(layout.rooms[0]!.rect.w * 2, 6);
    expect(moved.size).toBeCloseTo(layout.size * 2, 6);
  });
});
