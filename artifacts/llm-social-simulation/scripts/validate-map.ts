/**
 * Validates the deck map data model:
 *  - every room/corridor/POI is inside world bounds
 *  - no two rooms overlap
 *  - each corridor references real rooms and touches every one of them
 *  - each POI sits inside its room
 *  - the room graph is connected
 *
 * Run: bun scripts/validate-map.ts
 */
import { UMBRA_DECK_MAP as map, type Rect } from "../src/game/map";

const TOL = 3;
let failures = 0;

function fail(msg: string): void {
  failures++;
  console.error(`  ✗ ${msg}`);
}

function intersects(a: Rect, b: Rect, tol = 0): boolean {
  return (
    a.x < b.x + b.w + tol &&
    a.x + a.w + tol > b.x &&
    a.y < b.y + b.h + tol &&
    a.y + a.h + tol > b.y
  );
}

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

console.log(`Map: ${map.name} (${map.width}×${map.height})`);
console.log(
  `  ${map.rooms.length} rooms, ${map.corridors.length} corridors, ${map.pointsOfInterest.length} POIs\n`,
);

const world: Rect = { x: 0, y: 0, w: map.width, h: map.height };

// 1. World bounds.
for (const r of map.rooms) if (!inside(r, world)) fail(`room "${r.id}" out of bounds`);
for (const c of map.corridors) if (!inside(c, world)) fail(`corridor "${c.id}" out of bounds`);

// 2. Room overlaps.
for (let i = 0; i < map.rooms.length; i++) {
  for (let j = i + 1; j < map.rooms.length; j++) {
    const a = map.rooms[i];
    const b = map.rooms[j];
    if (intersects(a, b, -4)) fail(`rooms "${a.id}" and "${b.id}" overlap`);
  }
}

// 3. Corridors connect real rooms and touch both ends.
const roomIds = new Set(map.rooms.map((r) => r.id));
for (const c of map.corridors) {
  for (const id of c.connects) {
    if (!roomIds.has(id)) fail(`corridor "${c.id}" references unknown room "${id}"`);
  }
  for (const id of c.connects) {
    const room = map.rooms.find((r) => r.id === id);
    if (room && !intersects(c, room, TOL)) {
      fail(`corridor "${c.id}" does not touch room "${id}"`);
    }
  }
}

// 4. POIs inside their room.
for (const p of map.pointsOfInterest) {
  const room = map.rooms.find((r) => r.id === p.roomId);
  if (!room) {
    fail(`POI "${p.id}" references unknown room "${p.roomId}"`);
    continue;
  }
  if (
    p.x < room.x ||
    p.x > room.x + room.w ||
    p.y < room.y ||
    p.y > room.y + room.h
  ) {
    fail(`POI "${p.id}" (${p.x},${p.y}) is outside room "${room.id}"`);
  }
}

// 5. Graph connectivity.
const adj = new Map<string, string[]>();
for (const r of map.rooms) adj.set(r.id, []);
for (const c of map.corridors) {
  for (const a of c.connects) {
    for (const b of c.connects) {
      if (a !== b) adj.get(a)?.push(b);
    }
  }
}
const seen = new Set<string>();
const queue = [map.rooms[0].id];
while (queue.length) {
  const id = queue.shift()!;
  if (seen.has(id)) continue;
  seen.add(id);
  for (const next of adj.get(id) ?? []) queue.push(next);
}
if (seen.size !== map.rooms.length) {
  const unreachable = map.rooms.filter((r) => !seen.has(r.id)).map((r) => r.id);
  fail(`unreachable rooms: ${unreachable.join(", ")}`);
}

// Summary of POIs by kind.
const byKind = new Map<string, number>();
for (const p of map.pointsOfInterest) {
  byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
}
console.log("POIs by kind:");
for (const [kind, n] of [...byKind.entries()].sort()) console.log(`  ${kind}: ${n}`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll map checks passed ✓");
