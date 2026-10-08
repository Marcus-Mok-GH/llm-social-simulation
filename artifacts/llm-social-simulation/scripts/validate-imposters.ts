/**
 * Headless simulation of the AI imposters alongside crewmates. Verifies they:
 *  - navigate using pathfinding and stay walkable / in bounds
 *  - never perform crewmate tasks (no "working" state)
 *  - fake work at consoles for an alibi
 *  - never touch a vent: venting was removed from the game, so no imposter
 *    may enter the seeking_vent / venting states or rack up a vent travel
 *
 * Run: bun scripts/validate-imposters.ts
 */
import { canStand } from "../src/game/collision";
import { createCrewmates, crewmateWorkAt, updateCrewmate } from "../src/game/crewmate";
import { BASE_VISION, KILL_COOLDOWN, drawSeatModels } from "../src/game/engine";
import { createImposters, updateImposter, type ImposterState } from "../src/game/imposter";
import { UMBRA_DECK_MAP as map } from "../src/game/map";
import { buildNavGrid } from "../src/game/navigation";
import { makeLosTest } from "../src/game/vision";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

const ALLOWED: ImposterState[] = ["idle", "walking", "faking"];

const grid = buildNavGrid(map);
const los = makeLosTest(map);
const crew = createCrewmates(map, 4, 7);
const imps = createImposters(map, 2, 101);

// Imposters must not have crewmate task bookkeeping at all.
for (const imp of imps) {
  check(!("completedTasks" in imp), `${imp.name} has no task counter`);
}

const dt = 1 / 60;
const ticks = 60 * 240; // 240 simulated seconds — long enough that the old
// vent behaviour would have fired repeatedly if it were still present.

const stateTime = imps.map(() => new Map<string, number>());
const travel = imps.map(() => 0);
/** Stand-in for the engine referee: work starts on an explicit interaction. */
const worked = new Set<string>();
let allValid = true;
let crewEverWorked = false;

for (let t = 0; t < ticks; t++) {
  for (const c of crew) {
    updateCrewmate(map, grid, c, dt);
    if (c.state === "idle" && c.targetPoiId && !worked.has(`${c.id}:${c.targetPoiId}`)) {
      const poi = map.pointsOfInterest.find((p) => p.id === c.targetPoiId);
      if (poi && Math.hypot(poi.x - c.x, poi.y - c.y) <= 52) {
        crewmateWorkAt(c, map, poi.id);
        worked.add(`${c.id}:${c.targetPoiId}`);
      }
    }
    if (c.state === "working") crewEverWorked = true;
  }

  for (const imp of imps) {
    const px = imp.x;
    const py = imp.y;
    // The engine still passes "nobody is in sight" as `canVent`; with venting
    // removed from the planner it can never matter, but the travel machinery
    // keeps the gate so a driven trip still aborts when watched.
    const watched = crew.some(
      (c) => Math.hypot(c.x - imp.x, c.y - imp.y) <= BASE_VISION && los(imp.x, imp.y, c.x, c.y),
    );
    updateImposter(map, grid, imp, !watched, dt);

    if (!canStand(map, imp.x, imp.y, imp.radius)) allValid = false;
    if (imp.x < 0 || imp.x > map.width || imp.y < 0 || imp.y > map.height) allValid = false;
    if (!Number.isFinite(imp.x) || !Number.isFinite(imp.y)) allValid = false;
    if (!ALLOWED.includes(imp.state)) allValid = false;

    stateTime[imp.id].set(imp.state, (stateTime[imp.id].get(imp.state) ?? 0) + dt);
    travel[imp.id] += Math.hypot(imp.x - px, imp.y - py);
  }
}

check(allValid, "imposters stayed walkable, finite, in bounds, and out of the 'working' state");

// Contrast: crewmates run tasks, imposters never do.
check(crewEverWorked, "crewmates performed tasks (contrast with imposters)");

const totalVents = imps.reduce((s, i) => s + i.ventCount, 0);
check(totalVents === 0, `imposters never used a vent (total vent travels ${totalVents})`);

for (const imp of imps) {
  const faking = stateTime[imp.id].get("faking") ?? 0;
  const venting =
    (stateTime[imp.id].get("seeking_vent") ?? 0) + (stateTime[imp.id].get("venting") ?? 0);
  check(faking > 3, `${imp.name} spent time faking tasks for an alibi (${faking.toFixed(1)}s)`);
  check(travel[imp.id] > 500, `${imp.name} travelled via movement (${Math.round(travel[imp.id])}u)`);
  check(venting === 0, `${imp.name} never entered a vent state (${venting.toFixed(1)}s)`);
}

// ---------------------------------------------------------------------------
// Role casting: the traitors are a fresh random draw every shift
// ---------------------------------------------------------------------------
console.log("\nrole casting");
{
  const POOL = ["a/model", "b/model", "c/model", "d/model", "e/model"];
  const draw = (seed: number, avoid: readonly string[] = []) =>
    drawSeatModels(POOL, 2, avoid, seed);

  const first = draw(1);
  check(first.imposters.length === 2, "two models draw the knife each shift");
  check(
    first.imposters.every((m) => !first.crew.includes(m)) &&
      first.crew.every((m) => !first.imposters.includes(m)),
    "a traitor model never also plays honest crew in the same match",
  );
  check(
    [...first.imposters, ...first.crew].sort().join() === [...POOL].sort().join(),
    "every pool model is cast in exactly one seat",
  );
  check(
    draw(1).imposters.join() === first.imposters.join(),
    "the same shift seed re-casts the same traitors",
  );

  const pairs = new Set<string>();
  for (let seed = 1; seed <= 24; seed++) {
    pairs.add(draw(seed).imposters.slice().sort().join("|"));
  }
  check(
    pairs.size > 1,
    `different shifts cast different traitors (${pairs.size} distinct pairs over 24 seeds)`,
  );

  const changedEveryTime = Array.from({ length: 24 }, (_, i) => i + 1).every((seed) => {
    const prev = draw(seed);
    const next = draw(seed + 1, prev.imposters);
    return !next.imposters.some((m) => prev.imposters.includes(m));
  });
  check(
    changedEveryTime,
    "the next shift never opens with the pair that just played (pool allowing)",
  );

  const tiny = drawSeatModels(["only/model"], 2, ["only/model"], 7);
  check(
    tiny.imposters.length === 1 && tiny.crew.length === 1,
    "a one-model pool still casts every seat instead of failing",
  );
}

console.log("\nState time by imposter (seconds):");
for (const imp of imps) {
  const parts = ALLOWED.map((s) => `${s}=${(stateTime[imp.id].get(s) ?? 0).toFixed(1)}`).join("  ");
  console.log(`  ${imp.name.padEnd(6)} vents=${imp.ventCount}  walked=${Math.round(travel[imp.id])}u  ${parts}`);
}
console.log(`\nTotal vent travels: ${totalVents} (must be 0 — venting was removed)`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("Imposter AI checks passed ✓");
