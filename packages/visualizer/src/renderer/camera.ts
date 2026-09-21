/**
 * renderer/camera.ts — pure camera resolver + geometry transform (spec 063, R1).
 * ─────────────────────────────────────────────────────────────────────────
 * The camera is a view transform over the WORLD layer only; the HUD is DOM and
 * never moves. Two pure functions:
 *
 *  - `cameraFor(selection, layout, previous)` decides where the camera should
 *    be: identity when nothing is selected, centred on the selected agent
 *    otherwise, clamped so the viewport never shows past the world bounds.
 *  - `transformLayout(layout, camera)` applies the camera by transforming the
 *    geometry, so no 2D-context transform is needed (the drawing mocks in the
 *    suite only implement a narrow canvas subset).
 *
 * Both are deterministic and free of clock/IO: the client owns the time
 * dimension (it smooths the camera offsets with `smoothTowards`, spec 062 R2).
 */

import type { DoorLayout, EntityLayout, Point, Rect, RoomLayout, WorldLayout } from './layout.js';

export interface Camera {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** The fit-all view: `layoutWorld` already centres the world in the viewport. */
export const FIT_ALL_CAMERA: Camera = { scale: 1, offsetX: 0, offsetY: 0 };

/**
 * Automatic zoom used while following an agent. This is NOT user zoom (which
 * stays out of scope): `layoutWorld` fits the world to the viewport, so without
 * a scale-up there would be nothing to pan and the follow camera would be a
 * no-op. At this scale the world exceeds the viewport and clamping matters.
 */
export const FOLLOW_SCALE = 1.6;

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

/** Bounding box of every room in the layout (falls back to the viewport). */
export function worldBounds(layout: WorldLayout): Rect {
  if (layout.rooms.length === 0) {
    return { x: 0, y: 0, w: layout.viewport.width, h: layout.viewport.height };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const room of layout.rooms) {
    minX = Math.min(minX, room.rect.x);
    minY = Math.min(minY, room.rect.y);
    maxX = Math.max(maxX, room.rect.x + room.rect.w);
    maxY = Math.max(maxY, room.rect.y + room.rect.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Clamp a camera offset on one axis so the world edge never comes inside the
 * viewport. When the world is smaller than the viewport on that axis it is
 * centred instead (there is no offset that avoids showing past the bounds).
 */
function clampOffset(
  desired: number,
  worldMin: number,
  worldMax: number,
  viewportSize: number,
): number {
  const worldSize = worldMax - worldMin;
  if (worldSize >= viewportSize) {
    return clamp(desired, viewportSize - worldMax, -worldMin);
  }
  return (viewportSize - worldSize) / 2 - worldMin;
}

/**
 * The camera for a selection. `null` (or an agent not present in the layout)
 * yields the fit-all view at the previous scale. Otherwise the camera follows
 * at `FOLLOW_SCALE`, centred on the agent and clamped to the world bounds.
 */
export function cameraFor(
  selection: string | null,
  layout: WorldLayout,
  previous: Camera | null = null,
): Camera {
  if (selection === null) return { scale: previous?.scale ?? 1, offsetX: 0, offsetY: 0 };
  const agent = layout.agents.find((a) => a.id === selection);
  if (agent === undefined) return { scale: previous?.scale ?? 1, offsetX: 0, offsetY: 0 };

  const scale = FOLLOW_SCALE;
  const vw = layout.viewport.width;
  const vh = layout.viewport.height;
  const bounds = worldBounds(layout);
  const desiredX = vw / 2 - agent.x * scale;
  const desiredY = vh / 2 - agent.y * scale;
  return {
    scale,
    offsetX: clampOffset(desiredX, bounds.x * scale, (bounds.x + bounds.w) * scale, vw),
    offsetY: clampOffset(desiredY, bounds.y * scale, (bounds.y + bounds.h) * scale, vh),
  };
}

function transformRect(rect: Rect, camera: Camera): Rect {
  return {
    x: rect.x * camera.scale + camera.offsetX,
    y: rect.y * camera.scale + camera.offsetY,
    w: rect.w * camera.scale,
    h: rect.h * camera.scale,
  };
}

function transformPoint(p: Point, camera: Camera): Point {
  return { x: p.x * camera.scale + camera.offsetX, y: p.y * camera.scale + camera.offsetY };
}

function transformEntity(e: EntityLayout, camera: Camera): EntityLayout {
  const at = transformPoint({ x: e.x, y: e.y }, camera);
  return { id: e.id, roomId: e.roomId, x: at.x, y: at.y, visible: e.visible };
}

function transformDoor(door: DoorLayout, camera: Camera): DoorLayout {
  if (door.kind === 'opening') {
    return { ...door, rect: transformRect(door.rect, camera) };
  }
  return { ...door, points: door.points.map((p) => transformPoint(p, camera)) };
}

/**
 * Apply a camera by transforming the geometry. Pure; returns a new layout and
 * never mutates the input.
 */
export function transformLayout(layout: WorldLayout, camera: Camera): WorldLayout {
  if (camera.scale === 1 && camera.offsetX === 0 && camera.offsetY === 0) return layout;
  const rooms: RoomLayout[] = layout.rooms.map((room) => ({
    ...room,
    rect: transformRect(room.rect, camera),
  }));
  return {
    ...layout,
    rooms,
    doors: layout.doors.map((d) => transformDoor(d, camera)),
    objects: layout.objects.map((o) => transformEntity(o, camera)),
    agents: layout.agents.map((a) => transformEntity(a, camera)),
    size: layout.size * camera.scale,
  };
}
