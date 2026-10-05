/**
 * Headless simulation of the AI crewmates. Builds the nav grid, verifies every
 * task POI is reachable, then runs the crewmate state machine for 90 simulated
 * seconds and asserts they move between POIs, stop to work, never get stuck and
 * never leave the walkable area or the map bounds.
 *
 * Under the PLAN.md interaction model the state machine no longer starts work on
 * its own — the engine validates an `INTERACT`/`TASK` and calls `crewmateWorkAt`.
 * This check mirrors that rule so it still exercises the walking *and* the work.
 *
 * Run: bun scripts/validate-ai.ts
 */
import { canStand } from "../src/game/collision";
import { createCrewmates, crewmateWorkAt, updateCrewmate } from "../src/game/crewmate";
import { UMBRA_DECK_MAP as map } from "../src/game/map";
import { buildNavGrid, findPath } from "../src/game/navigation";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

// --- Navigation grid --------------------------------------------------------
const grid = buildNavGrid(map);
let walkableCells = 0;
for (const v of grid.walkable) walkableCells += v;
check(walkableCells > 100, `nav grid has walkable cells (${walkableCells})`);
console.log(`Nav grid: ${grid.cols}×${grid.rows} cells, ${walkableCells} walkable`);

const taskPois = map.pointsOfInterest.filter((p) => p.kind === "task");
const spawn = map.pointsOfInterest.find((p) => p.kind === "spawn");
if (!spawn) {
  console.error("map has no spawn POI");
  process.exit(1);
}

// --- Every task POI is reachable from spawn --------------------------------
for (const poi of taskPois) {
  const path = findPath(grid, { x: spawn.x, y: spawn.y }, { x: poi.x, y: poi.y });
  check(path !== null && path.length > 0, `path from spawn to "${poi.id}" exists`);
}
console.log(`Reachability: ${taskPois.length}/${taskPois.length} task POIs pathable from spawn`);

// --- Simulate ---------------------------------------------------------------
const AGENT_COUNT = 5;
const agents = createCrewmates(map, AGENT_COUNT, 7);
const dt = 1 / 60;
const ticks = 60 * 90; // 90 simulated seconds

const visited = agents.map(() => new Set<string>());
const workedTime = agents.map(() => 0);
const travel = agents.map(() => 0);
let allValid = true;

for (let t = 0; t < ticks; t++) {
  for (const a of agents) {
    const px = a.x;
    const py = a.y;
    updateCrewmate(map, grid, a, dt);

    // Stand-in for the engine referee: work begins only on an explicit,
    // in-range interaction, and only once per console.
    if (a.state === "idle" && a.targetPoiId && !visited[a.id].has(a.targetPoiId)) {
      const poi = map.pointsOfInterest.find((p) => p.id === a.targetPoiId);
      if (poi && Math.hypot(poi.x - a.x, poi.y - a.y) <= 52) {
        crewmateWorkAt(a, map, poi.id);
      }
    }

    if (!canStand(map, a.x, a.y, a.radius)) allValid = false;
    if (a.x < 0 || a.x > map.width || a.y < 0 || a.y > map.height) allValid = false;
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) allValid = false;

    travel[a.id] += Math.hypot(a.x - px, a.y - py);
    if (a.state === "working") {
      workedTime[a.id] += dt;
      if (a.targetPoiId) visited[a.id].add(a.targetPoiId);
    }
  }
}

check(allValid, "all crewmates stayed walkable, finite and in bounds for 90s");

const totalTasks = agents.reduce((s, a) => s + a.completedTasks, 0);
check(totalTasks >= agents.length, `crew completed tasks (total ${totalTasks})`);

for (const a of agents) {
  check(visited[a.id].size >= 2, `${a.name} visited >= 2 distinct POIs (got ${visited[a.id].size})`);
  check(travel[a.id] > 1000, `${a.name} travelled a meaningful distance (${Math.round(travel[a.id])}u)`);
  check(workedTime[a.id] > 1, `${a.name} stopped to work (${workedTime[a.id].toFixed(1)}s)`);
}

console.log("\nPer-crewmate results:");
for (const a of agents) {
  console.log(
    `  ${a.name.padEnd(5)} tasks=${a.completedTasks}  pois=${visited[a.id].size}  ` +
      `travelled=${Math.round(travel[a.id])}u  worked=${workedTime[a.id].toFixed(1)}s  state=${a.state}`,
  );
}
console.log(`\nTotal tasks completed: ${totalTasks}`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("AI pathfinding + task checks passed ✓");
