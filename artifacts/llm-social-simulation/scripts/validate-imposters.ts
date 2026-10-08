/**
 * Headless simulation of the AI imposters alongside crewmates. Verifies they:
 *  - navigate using pathfinding and stay walkable / in bounds
 *  - never perform crewmate tasks (no "working" state)
 *  - fake work at consoles for an alibi
 *  - use vent POIs to travel, emerging at a different vent
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

const ALLOWED: ImposterState[] = ["idle", "walking", "faking", "seeking_vent", "venting"];
const vents = map.pointsOfInterest.filter((p) => p.kind === "vent");
check(vents.length >= 2, `map has at least 2 vent POIs (got ${vents.length})`);
console.log(`Vent POIs available: ${vents.length}`);

const grid = buildNavGrid(map);
const los = makeLosTest(map);
const crew = createCrewmates(map, 4, 7);
const imps = createImposters(map, 2, 101);

// Imposters must not have crewmate task bookkeeping at all.
for (const imp of imps) {
  check(!("completedTasks" in imp), `${imp.name} has no task counter`);
}

const dt = 1 / 60;
const ticks = 60 * 240; // 240 simulated seconds — long enough that both
// imposters get unwatched moments to vent under the honest sight-only rule.

const stateTime = imps.map(() => new Map<string, number>());
const travel = imps.map(() => 0);
/** Stand-in for the engine referee: work starts on an explicit interaction. */
const worked = new Set<string>();
let allValid = true;
let crewEverWorked = false;
let ventJumps = 0;
let maxVentJump = 0;

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
    const before = imp.state;
    // Same rule the engine referee applies: venting is only offered when no
    // crewmate is within sight (range + line of sight), so the state machine
    // is exercised exactly as it behaves in a real match.
    const watched = crew.some(
      (c) => Math.hypot(c.x - imp.x, c.y - imp.y) <= BASE_VISION && los(imp.x, imp.y, c.x, c.y),
    );
    updateImposter(map, grid, imp, !watched, dt);

    if (!canStand(map, imp.x, imp.y, imp.radius)) allValid = false;
    if (imp.x < 0 || imp.x > map.width || imp.y < 0 || imp.y > map.height) allValid = false;
    if (!Number.isFinite(imp.x) || !Number.isFinite(imp.y)) allValid = false;
    if (!ALLOWED.includes(imp.state)) allValid = false;

    stateTime[imp.id].set(imp.state, (stateTime[imp.id].get(imp.state) ?? 0) + dt);

    if (before === "venting" && imp.state !== "venting") {
      // Teleport out of the vent: measure the jump instead of walking it.
      ventJumps++;
      maxVentJump = Math.max(maxVentJump, Math.hypot(imp.x - px, imp.y - py));
    } else {
      travel[imp.id] += Math.hypot(imp.x - px, imp.y - py);
    }
  }
}

check(allValid, "imposters stayed walkable, finite, in bounds, and out of the 'working' state");

// Contrast: crewmates run tasks, imposters never do.
check(crewEverWorked, "crewmates performed tasks (contrast with imposters)");

const totalVents = imps.reduce((s, i) => s + i.ventCount, 0);
check(totalVents >= 2, `imposters used vents (total vent travels ${totalVents})`);
check(ventJumps >= 2, `observed vent teleports (${ventJumps})`);
check(maxVentJump > 150, `vent travel moved the imposter a meaningful distance (max ${Math.round(maxVentJump)}u)`);

for (const imp of imps) {
  const faking = stateTime[imp.id].get("faking") ?? 0;
  check(faking > 3, `${imp.name} spent time faking tasks for an alibi (${faking.toFixed(1)}s)`);
  check(travel[imp.id] > 500, `${imp.name} travelled via movement (${Math.round(travel[imp.id])}u)`);
  check(imp.ventCount >= 1, `${imp.name} personally used a vent (${imp.ventCount})`);
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
console.log(`\nTotal vent travels: ${totalVents}  |  max vent jump: ${Math.round(maxVentJump)}u`);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("Imposter AI checks passed ✓");
