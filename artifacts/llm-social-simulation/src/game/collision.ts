import type { GameMap, Rect } from "./map";

export interface Vec2 {
  x: number;
  y: number;
}

/** The traversable area is the union of every room and corridor rectangle. */
export function walkableRects(map: GameMap): Rect[] {
  return [...map.rooms, ...map.corridors];
}

/** Inclusive point-in-rect so shared edges between a room and its corridor count as inside. */
export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export function pointWalkable(x: number, y: number, rects: Rect[]): boolean {
  for (const r of rects) if (pointInRect(x, y, r)) return true;
  return false;
}

// A perimeter ring is intentionally denser than the navigation grid. The map
// is made from axis-aligned wall runs, so a sparse ring can otherwise miss a
// short corner contact and let an actor enter the adjacent room.
// The map is represented as a union of axis-aligned floor rectangles. A
// coarse perimeter ring can skip a thin wall corner when an actor approaches
// it diagonally, so use a near-pixel ring for every collision query. This is
// intentionally conservative: a position is valid only when the entire actor
// perimeter is still on the floor union.
const SAMPLE_COUNT = 360;
const SWEEP_SAMPLE_STEP = 1;

/**
 * Longest single collision-checked step. The per-axis endpoint check below is
 * only sound while a step is shorter than the actor's clearance: a step longer
 * than twice the actor's radius could land on walkable ground on the far side
 * of a wall and cross it in one frame. Anything longer than `MAX_STEP` is
 * therefore split into fully-checked sub-steps, so a frame hitch, a large
 * `dt`, or a future speed retune can never let an actor tunnel through a wall.
 */
const MAX_STEP = 6;

/**
 * A circle is walkable when its centre *and* a ring of samples around its
 * perimeter all fall inside the union of walkable rects. Sampling (rather than
 * exact geometry) keeps the test simple and still handles seams where a circle
 * straddles the boundary between a room and its corridor.
 */
export function circleWalkable(
  x: number,
  y: number,
  radius: number,
  rects: Rect[],
  samples = SAMPLE_COUNT,
): boolean {
  if (!pointWalkable(x, y, rects)) return false;
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const sx = x + Math.cos(a) * radius;
    const sy = y + Math.sin(a) * radius;
    if (!pointWalkable(sx, sy, rects)) return false;
  }
  return true;
}

export function canStand(
  map: GameMap,
  x: number,
  y: number,
  radius: number,
): boolean {
  return circleWalkable(x, y, radius, walkableRects(map));
}

/**
 * Nearest position an agent of `radius` can actually stand in.
 *
 * Anything that teleports an actor (meeting seating, vent travel) can land it
 * in a wall pocket that incremental movement can never escape, because each
 * small step is individually blocked. Snapping out of that pocket is the
 * cheap insurance policy.
 */
export function nearestStandable(
  map: GameMap,
  x: number,
  y: number,
  radius: number,
): Vec2 {
  if (canStand(map, x, y, radius)) return { x, y };
  for (let r = 8; r <= 420; r += 8) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const nx = x + Math.cos(a) * r;
      const ny = y + Math.sin(a) * r;
      if (canStand(map, nx, ny, radius)) return { x: nx, y: ny };
    }
  }
  return { x, y };
}

/**
 * Axis-separated movement: try the X step, then the Y step. Each axis is only
 * committed if the result is walkable, which produces wall-sliding along
 * corridors instead of hard stops. Steps longer than `MAX_STEP` are split
 * into fully-checked sub-steps first (see the constant above).
 */
function sweptCircleWalkable(
  from: Vec2,
  to: Vec2,
  radius: number,
  rects: Rect[],
): boolean {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / SWEEP_SAMPLE_STEP));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!circleWalkable(
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t,
      radius,
      rects,
    )) return false;
  }
  return true;
}

export function moveWithCollision(
  map: GameMap,
  pos: Vec2,
  dx: number,
  dy: number,
  radius: number,
): Vec2 {
  const dist = Math.hypot(dx, dy);
  if (dist > MAX_STEP) {
    const steps = Math.ceil(dist / MAX_STEP);
    let p = pos;
    for (let i = 0; i < steps; i++) {
      p = moveWithCollision(map, p, dx / steps, dy / steps, radius);
    }
    return p;
  }

  const rects = walkableRects(map);
  let { x, y } = pos;

  const nx = x + dx;
  if (
    dx !== 0 &&
    sweptCircleWalkable({ x, y }, { x: nx, y }, radius, rects)
  ) x = nx;

  const ny = y + dy;
  if (
    dy !== 0 &&
    sweptCircleWalkable({ x, y }, { x, y: ny }, radius, rects)
  ) y = ny;

  return { x, y };
}
