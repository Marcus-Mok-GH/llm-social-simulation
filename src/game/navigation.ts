import { circleWalkable, moveWithCollision, walkableRects, type Vec2 } from "./collision";
import type { GameMap, Rect } from "./map";

const FOLLOW_ARRIVE_EPS = 9;
const FOLLOW_STUCK_LIMIT = 1.2;

/**
 * Navigation grid derived from the map's walkable area. A cell is walkable when
 * a circle of `radius` fits at its centre, so paths are already clearanced for
 * an agent of that size.
 */
export interface NavGrid {
  cell: number;
  cols: number;
  rows: number;
  radius: number;
  walkable: Uint8Array;
  rects: Rect[];
}

export function buildNavGrid(
  map: GameMap,
  cell = 24,
  radius = 15,
): NavGrid {
  const cols = Math.ceil(map.width / cell);
  const rows = Math.ceil(map.height / cell);
  const walkable = new Uint8Array(cols * rows);
  const rects = walkableRects(map);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cx = gx * cell + cell / 2;
      const cy = gy * cell + cell / 2;
      if (circleWalkable(cx, cy, radius, rects)) walkable[gy * cols + gx] = 1;
    }
  }
  return { cell, cols, rows, radius, walkable, rects };
}

function cellCenter(grid: NavGrid, gx: number, gy: number): Vec2 {
  return { x: gx * grid.cell + grid.cell / 2, y: gy * grid.cell + grid.cell / 2 };
}

function isWalkableCell(grid: NavGrid, gx: number, gy: number): boolean {
  if (gx < 0 || gy < 0 || gx >= grid.cols || gy >= grid.rows) return false;
  return grid.walkable[gy * grid.cols + gx] === 1;
}

/** Nearest walkable cell to a world point (spiral search). */
function nearestWalkableCell(
  grid: NavGrid,
  x: number,
  y: number,
): { gx: number; gy: number } | null {
  const gx0 = Math.min(grid.cols - 1, Math.max(0, Math.floor(x / grid.cell)));
  const gy0 = Math.min(grid.rows - 1, Math.max(0, Math.floor(y / grid.cell)));
  if (isWalkableCell(grid, gx0, gy0)) return { gx: gx0, gy: gy0 };

  const maxR = Math.max(grid.cols, grid.rows);
  for (let r = 1; r < maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const gx = gx0 + dx;
        const gy = gy0 + dy;
        if (isWalkableCell(grid, gx, gy)) return { gx, gy };
      }
    }
  }
  return null;
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.vals[0];
    const lastKey = this.keys.pop() as number;
    const lastVal = this.vals.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.vals[a], this.vals[b]] = [this.vals[b], this.vals[a]];
  }
}

/** Minimal shape needed to walk a computed path. */
export interface PathFollower {
  x: number;
  y: number;
  radius: number;
  speed: number;
  facingX: number;
  facingY: number;
  path: Vec2[];
  pathIndex: number;
  stagnant: number;
}

export type FollowResult = "arrived" | "moving" | "blocked";

/**
 * Advance a follower along its path using collision-aware movement. Returns
 * "blocked" when no progress is being made, so callers can re-path.
 */
export function followPath(
  map: GameMap,
  f: PathFollower,
  dt: number,
): FollowResult {
  if (f.pathIndex >= f.path.length) return "arrived";

  const target = f.path[f.pathIndex];
  const dx = target.x - f.x;
  const dy = target.y - f.y;
  const dist = Math.hypot(dx, dy);

  if (dist <= FOLLOW_ARRIVE_EPS) {
    f.pathIndex++;
    return f.pathIndex >= f.path.length ? "arrived" : "moving";
  }

  const ux = dx / dist;
  const uy = dy / dist;
  f.facingX = ux;
  f.facingY = uy;

  const step = f.speed * dt;
  const before = { x: f.x, y: f.y };
  const next = moveWithCollision(map, before, ux * step, uy * step, f.radius);
  f.x = next.x;
  f.y = next.y;

  const moved = Math.hypot(f.x - before.x, f.y - before.y);
  if (moved < step * 0.25) {
    f.stagnant += dt;
    if (f.stagnant > FOLLOW_STUCK_LIMIT) return "blocked";
  } else {
    f.stagnant = 0;
  }
  return "moving";
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

/** Does the straight segment between two points stay clearanced for the agent? */
function segmentClear(grid: NavGrid, a: Vec2, b: Vec2): boolean {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / (grid.cell / 2)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (!circleWalkable(x, y, grid.radius, grid.rects)) return false;
  }
  return true;
}

/** Drop waypoints that can be skipped with a clear straight run. */
function simplify(grid: NavGrid, pts: Vec2[]): Vec2[] {
  if (pts.length <= 2) return pts;
  const out: Vec2[] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !segmentClear(grid, pts[i], pts[j])) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** A* path between two world points. Returns waypoints, or null if unreachable. */
export function findPath(grid: NavGrid, from: Vec2, to: Vec2): Vec2[] | null {
  const start = nearestWalkableCell(grid, from.x, from.y);
  const goal = nearestWalkableCell(grid, to.x, to.y);
  if (!start || !goal) return null;

  const size = grid.cols * grid.rows;
  const startIdx = start.gy * grid.cols + start.gx;
  const goalIdx = goal.gy * grid.cols + goal.gx;

  const buildPoints = (cellPath: { gx: number; gy: number }[]): Vec2[] => {
    const pts = cellPath.map((c) => cellCenter(grid, c.gx, c.gy));
    if (circleWalkable(to.x, to.y, grid.radius, grid.rects)) pts.push({ x: to.x, y: to.y });
    return simplify(grid, pts);
  };

  if (startIdx === goalIdx) return buildPoints([start]);

  const gScore = new Float64Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  const heuristic = (gx: number, gy: number): number => {
    const dx = Math.abs(gx - goal.gx);
    const dy = Math.abs(gy - goal.gy);
    return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };

  const open = new MinHeap();
  gScore[startIdx] = 0;
  open.push(heuristic(start.gx, start.gy), startIdx);

  while (open.size > 0) {
    const current = open.pop();
    if (closed[current]) continue;
    closed[current] = 1;

    if (current === goalIdx) {
      const cells: { gx: number; gy: number }[] = [];
      let node = current;
      while (node !== -1) {
        cells.push({ gx: node % grid.cols, gy: Math.floor(node / grid.cols) });
        node = cameFrom[node];
      }
      cells.reverse();
      return buildPoints(cells);
    }

    const cgx = current % grid.cols;
    const cgy = Math.floor(current / grid.cols);

    for (const [dx, dy] of DIRS) {
      const nx = cgx + dx;
      const ny = cgy + dy;
      if (!isWalkableCell(grid, nx, ny)) continue;
      // No corner cutting: a diagonal needs both orthogonal neighbours open.
      if (dx !== 0 && dy !== 0) {
        if (!isWalkableCell(grid, cgx + dx, cgy) || !isWalkableCell(grid, cgx, cgy + dy)) {
          continue;
        }
      }
      const nIdx = ny * grid.cols + nx;
      if (closed[nIdx]) continue;

      const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
      const tentative = gScore[current] + step;
      if (tentative < gScore[nIdx]) {
        gScore[nIdx] = tentative;
        cameFrom[nIdx] = current;
        open.push(tentative + heuristic(nx, ny), nIdx);
      }
    }
  }

  return null;
}
