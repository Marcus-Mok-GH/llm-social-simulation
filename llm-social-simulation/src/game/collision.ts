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

const SAMPLE_COUNT = 16;

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
 * Axis-separated movement: try the X step, then the Y step. Each axis is only
 * committed if the result is walkable, which produces wall-sliding along
 * corridors instead of hard stops.
 */
export function moveWithCollision(
  map: GameMap,
  pos: Vec2,
  dx: number,
  dy: number,
  radius: number,
): Vec2 {
  const rects = walkableRects(map);
  let { x, y } = pos;

  const nx = x + dx;
  if (dx !== 0 && circleWalkable(nx, y, radius, rects)) x = nx;

  const ny = y + dy;
  if (dy !== 0 && circleWalkable(x, ny, radius, rects)) y = ny;

  return { x, y };
}
