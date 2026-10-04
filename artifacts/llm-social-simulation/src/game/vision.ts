/**
 * Vision: line-of-sight, the ray-cast visibility polygon, and the persistent
 * "explored" memory that drives the fog-of-war layer.
 *
 * Two representations are used on purpose:
 *
 *  - `losClear()` samples a straight segment against the walkable rectangles.
 *    It is exact enough for perception ("did agent A see agent B?") and is only
 *    run at 10 Hz for a handful of pairs, so it can afford to be precise.
 *
 *  - `VisibilityGrid` is a coarse raster of open space used for the *renderer*,
 *    where hundreds of rays must be marched every frame. Marching cells is
 *    ~50x cheaper than intersecting rectangles.
 */

import { pointWalkable, walkableRects } from "./collision";
import type { GameMap, Rect } from "./map";

// ---------------------------------------------------------------------------
// Exact line of sight
// ---------------------------------------------------------------------------

const LOS_STEP = 4;

/** Returns a closure with the map's rectangles already captured. */
export function makeLosTest(map: GameMap): (ax: number, ay: number, bx: number, by: number) => boolean {
  const rects: Rect[] = walkableRects(map);

  return (ax, ay, bx, by): boolean => {
    const dist = Math.hypot(bx - ax, by - ay);
    if (dist < 0.001) return true;
    const steps = Math.ceil(dist / LOS_STEP);
    // Skip the endpoints: they are the observer and the target, both of which
    // are standing in open space by definition.
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!pointWalkable(ax + (bx - ax) * t, ay + (by - ay) * t, rects)) return false;
    }
    return true;
  };
}

// ---------------------------------------------------------------------------
// Coarse visibility raster
// ---------------------------------------------------------------------------

export interface VisibilityGrid {
  cell: number;
  cols: number;
  rows: number;
  /** 1 when the cell centre lies in open space. */
  open: Uint8Array;
  /** 1 once the cell has been inside the player's vision at least once. */
  explored: Uint8Array;
}

export function buildVisibilityGrid(map: GameMap, cell = 12): VisibilityGrid {
  const cols = Math.ceil(map.width / cell);
  const rows = Math.ceil(map.height / cell);
  const open = new Uint8Array(cols * rows);
  const rects = walkableRects(map);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cx = gx * cell + cell / 2;
      const cy = gy * cell + cell / 2;
      if (pointWalkable(cx, cy, rects)) open[gy * cols + gx] = 1;
    }
  }

  return { cell, cols, rows, open, explored: new Uint8Array(cols * rows) };
}

function isOpenAt(g: VisibilityGrid, x: number, y: number): boolean {
  const gx = Math.floor(x / g.cell);
  const gy = Math.floor(y / g.cell);
  if (gx < 0 || gy < 0 || gx >= g.cols || gy >= g.rows) return false;
  return g.open[gy * g.cols + gx] === 1;
}

function markExplored(g: VisibilityGrid, x: number, y: number): void {
  const gx = Math.floor(x / g.cell);
  const gy = Math.floor(y / g.cell);
  if (gx < 0 || gy < 0 || gx >= g.cols || gy >= g.rows) return;
  g.explored[gy * g.cols + gx] = 1;
}

// ---------------------------------------------------------------------------
// Vision polygon
// ---------------------------------------------------------------------------

/**
 * March `rays` evenly spaced rays from `(ox, oy)` out to `range`, stopping at
 * the first closed cell. Returns a flat `[x0,y0,x1,y1,...]` polyline that the
 * renderer uses as the lit region.
 *
 * Rays are spaced tighter than one cell even at maximum range (360 rays cover
 * ~7px of arc at r=400 while the cell is 12px), which keeps the explored
 * raster free of gaps.
 */
export function castVision(
  g: VisibilityGrid,
  ox: number,
  oy: number,
  range: number,
  rays = 360,
): Float32Array {
  const out = new Float32Array(rays * 2);
  const step = g.cell * 0.5;

  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);

    let x = ox;
    let y = oy;
    let travelled = 0;

    while (travelled < range) {
      const nx = x + dx * step;
      const ny = y + dy * step;
      if (!isOpenAt(g, nx, ny)) break;
      x = nx;
      y = ny;
      travelled += step;
      markExplored(g, x, y);
    }

    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }

  return out;
}

/** Reveal a disc (used for spawn, vents and meeting teleports). */
export function revealAround(g: VisibilityGrid, x: number, y: number, radius: number): void {
  const r = radius;
  for (let dy = -r; dy <= r; dy += g.cell) {
    for (let dx = -r; dx <= r; dx += g.cell) {
      if (dx * dx + dy * dy <= r * r) markExplored(g, x + dx, y + dy);
    }
  }
  markExplored(g, x, y);
}

/** Count of revealed cells — surfaced in the HUD as "deck surveyed". */
export function exploredRatio(g: VisibilityGrid): number {
  let n = 0;
  for (let i = 0; i < g.explored.length; i++) n += g.explored[i];
  return n / g.explored.length;
}
