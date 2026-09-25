/**
 * Spec 066 — leg 1: releasing follow returns to fit-all.
 * =====================================================
 * AC-4 (D2). The shipped defect: `cameraFor(null, layout, previous)` returned
 * `previous.scale` — the 1.6x follow zoom — with zeroed offsets, so releasing a
 * follow left a magnified view anchored at the world origin (mostly empty
 * space). Measured live: following `{scale 1.6, offsetX -382.69}`, after release
 * `{scale 1.6, offsetX -0.089}`, where fit-all is `{scale 1, 0}`.
 *
 * Why this file exists rather than an extra case in `renderer-camera.test.ts`:
 * that suite calls `cameraFor(null, layout)` with **no `previous` argument**, so
 * `previous` is always `null` and the buggy branch is only ever exercised with
 * its `1` default. Production always passes the live camera. The gap is the
 * test's default differing from runtime, so these cases pass `previous`
 * explicitly — the production shape.
 *
 * The last case asserts the *outcome* the spec asks for (a released camera shows
 * the whole world) rather than re-checking the returned object, which would
 * merely restate the implementation.
 */
import { describe, it, expect } from 'vitest';
import type { VisualizerRoom, VisualizerState } from '@evol-hive/shared';
import { layoutWorld, ZERO_INSETS } from '../src/renderer/layout.js';
import type { Viewport, WorldLayout } from '../src/renderer/layout.js';
import {
  CAMERA_HALF_LIFE_S,
  FOLLOW_SCALE,
  cameraFor,
  smoothCamera,
  worldBounds,
} from '../src/renderer/camera.js';
import type { Camera } from '../src/renderer/camera.js';

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

/** The camera a live follow actually holds — never the `1` default. */
const LIVE_FOLLOW: Camera = { scale: FOLLOW_SCALE, offsetX: -382.69, offsetY: -61.86 };

const layout = (): WorldLayout => layoutWorld(state({ x: 3, y: 3 }), VIEWPORT);

/** Is the whole world inside the viewport at this camera? (fit-all's meaning) */
function worldFits(l: WorldLayout, camera: Camera): boolean {
  const b = worldBounds(l);
  const eps = 0.5;
  return (
    b.x * camera.scale + camera.offsetX >= -eps &&
    b.y * camera.scale + camera.offsetY >= -eps &&
    (b.x + b.w) * camera.scale + camera.offsetX <= l.viewport.width + eps &&
    (b.y + b.h) * camera.scale + camera.offsetY <= l.viewport.height + eps
  );
}

describe('spec 066 — releasing follow returns to fit-all (AC-4)', () => {
  it('releases to fit-all when previous is a LIVE follow camera (the production path)', () => {
    const l = layout();
    // Arrange: the agent really is being followed at the follow zoom.
    expect(cameraFor('a1', l, LIVE_FOLLOW).scale).toBe(FOLLOW_SCALE);

    // Act: release.
    const released = cameraFor(null, l, LIVE_FOLLOW);

    // Assert: fit-all, not the follow zoom with zeroed offsets.
    expect(released).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  it('releases to fit-all when the selected agent is no longer in the layout', () => {
    const l = layout();
    expect(cameraFor('gone', l, LIVE_FOLLOW)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  it('shows the whole world after release (the outcome, not the return shape)', () => {
    const l = layout();
    expect(worldFits(l, cameraFor(null, l, LIVE_FOLLOW))).toBe(true);
    // Guard against a vacuous pass: at the follow zoom the world does NOT fit,
    // which is exactly what "dragged to nowhere" looked like.
    expect(worldFits(l, LIVE_FOLLOW)).toBe(false);
  });

  it('keeps fit-all when there was never a selection', () => {
    const l = layout();
    expect(cameraFor(null, l)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });
});

/**
 * AC-5: the release must GLIDE. The client previously smoothed the offsets while
 * assigning `scale` instantly, so releasing was a hard zoom-out followed by a
 * slide. That policy lived inline in `client/main.ts`, where no test could see
 * it — moving it to a pure function in `renderer/` is what makes it assertable,
 * and matches spec 062's rule that visual rules live in the renderer, not the
 * DOM glue.
 */
describe('spec 066 — the release transition glides rather than snapping (AC-5)', () => {
  const FIT_ALL: Camera = { scale: 1, offsetX: 0, offsetY: 0 };

  it('moves the scale part of the way in one frame, not all the way', () => {
    const oneFrame = smoothCamera(LIVE_FOLLOW, FIT_ALL, 1 / 60, CAMERA_HALF_LIFE_S);
    expect(oneFrame.scale).toBeLessThan(FOLLOW_SCALE); // it did move...
    expect(oneFrame.scale).toBeGreaterThan(1); // ...but it did not snap
    expect(oneFrame.offsetX).toBeGreaterThan(LIVE_FOLLOW.offsetX);
  });

  it('converges to fit-all', () => {
    let cam: Camera = LIVE_FOLLOW;
    for (let frame = 0; frame < 240; frame++) {
      cam = smoothCamera(cam, FIT_ALL, 1 / 60, CAMERA_HALF_LIFE_S);
    }
    expect(cam.scale).toBeCloseTo(1, 3);
    expect(cam.offsetX).toBeCloseTo(0, 1);
    expect(cam.offsetY).toBeCloseTo(0, 1);
  });

  it('leaves the camera untouched for a zero-length frame (no jump on a stall)', () => {
    expect(smoothCamera(LIVE_FOLLOW, FIT_ALL, 0, CAMERA_HALF_LIFE_S)).toEqual(LIVE_FOLLOW);
  });

  it('defaults its half-life so callers cannot silently pass a different one', () => {
    expect(smoothCamera(LIVE_FOLLOW, FIT_ALL, 1 / 60)).toEqual(
      smoothCamera(LIVE_FOLLOW, FIT_ALL, 1 / 60, CAMERA_HALF_LIFE_S),
    );
  });
});
