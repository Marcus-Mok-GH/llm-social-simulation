/**
 * Wall-integrity check: replay full matches and prove that AI movement never
 * leaves the walkable area and never crosses the station's geometry.
 *
 * Three independent assertions run for every living actor, every frame:
 *
 *   1. Position — the engine's own `canStand` must hold wherever an actor
 *      stands. A failure means an actor is inside a wall.
 *   2. Movement — the frame's displacement must not exceed what the actor's
 *      own speed allows in one tick. Anything faster is a teleport and is
 *      handled by (3). Together with the static tunneling probe — which
 *      proves `moveWithCollision`, the only code that moves living actors,
 *      never covers non-walkable ground at any step size — this rules out
 *      wall crossing: a crossing would have to be either collision walking
 *      over geometry (excluded by the probe) or an unclassified teleport
 *      (excluded here).
 *   3. Relocation — any single-frame jump larger than a few continuous steps
 *      is a teleport. Meeting seating and vent travel are intended mechanics
 *      and are classified (and destination-checked); anything else is an
 *      unexplained relocation (e.g. the safety-net snap) and fails the check,
 *      whether or not the straight line between the two positions crosses a
 *      wall.
 *
 * Matches are replayed at three tick sizes: the fixed 60 Hz the headless
 * scripts use, the 50 ms worst case the browser's frame loop clamps to, and a
 * hostile 300 ms that exceeds anything the game currently feeds the engine —
 * endpoint-only collision is only sound while a step is shorter than the
 * actor's clearance radius, so a large `dt` is exactly where wall tunneling
 * would appear first.
 *
 * Static checks up front: every point of interest and every zone stand point
 * must be walkable for both actor radii, so intents that name them can never
 * demand a destination inside geometry.
 *
 * Run: bun scripts/validate-walls.ts
 */

import {
  canStand,
  moveWithCollision,
  pointWalkable,
  walkableRects,
  type Vec2,
} from "../src/game/collision";
import { GameEngine } from "../src/game/engine";
import { UMBRA_DECK_MAP, nearestPoi, type PointOfInterest, type Rect } from "../src/game/map";
import { buildNavGrid, findPath, type NavGrid } from "../src/game/navigation";
import { standPoint, type Zone } from "../src/game/zones";

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`  ✗ ${msg}`);
}

const MOVE = ["w", "a", "s", "d"];

/** Rounding slack for the per-frame physical step bound. */
const STEP_SLACK = 0.5;
/** Step used when sampling a movement path against the walkable union. */
const SAMPLE_STEP = 2;
/** How far from the meeting table a seated actor may land. */
const SEAT_RADIUS = 320;

interface DriverState {
  grid: NavGrid;
  path: Vec2[];
  wp: number;
  target: string;
  stuck: number;
  repath: number;
  lastX: number;
  lastY: number;
}

const driverState = new WeakMap<GameEngine, DriverState>();
const WAYPOINT_EPS = 12;
const INTERACT_DIST = 50;
const STUCK_SECONDS = 1.2;
const REPATH_COOLDOWN = 0.25;

/**
 * Minimal stand-in player, mirroring the headless driver in simulate.ts: walk
 * to the next assigned console, work it, report bodies, and cover a kill at
 * the beacon once when playing impostor.
 */
function drivePlayer(engine: GameEngine): void {
  const me = engine.playerActor;
  if (engine.phase !== "playing" || !me.alive) {
    for (const k of MOVE) engine.setKey(k, false);
    return;
  }
  if (engine.report()) {
    for (const k of MOVE) engine.setKey(k, false);
    return;
  }
  const task = me.tasks.find((t) => !t.done);
  const beacon = engine.map.pointsOfInterest.find((p) => p.kind === "emergency");
  const coveringKill =
    !!beacon && me.role === "imposter" && engine.meetingsHeld === 0 && engine.time > 20;

  let goal: PointOfInterest;
  let goalId: string;
  if (coveringKill && beacon) {
    goal = beacon;
    goalId = "beacon";
  } else if (task) {
    const poi = engine.map.pointsOfInterest.find((p) => p.id === task.poiId);
    if (!poi) return;
    goal = poi;
    goalId = task.poiId;
  } else {
    for (const k of MOVE) engine.setKey(k, false);
    return;
  }

  let st = driverState.get(engine);
  if (!st) {
    st = {
      grid: buildNavGrid(engine.map, 24, 16),
      path: [],
      wp: 0,
      target: "",
      stuck: 0,
      repath: 0,
      lastX: me.entity.x,
      lastY: me.entity.y,
    };
    driverState.set(engine, st);
  }

  const dist = Math.hypot(goal.x - me.entity.x, goal.y - me.entity.y);
  if (dist < INTERACT_DIST) {
    for (const k of MOVE) engine.setKey(k, false);
    engine.interact();
    return;
  }

  const repath = (): void => {
    st.path = findPath(st.grid, { x: me.entity.x, y: me.entity.y }, { x: goal.x, y: goal.y }) ?? [];
    st.wp = 0;
    st.target = goalId;
    st.stuck = 0;
    st.repath = REPATH_COOLDOWN;
  };

  if (st.target !== goalId) repath();
  else st.repath = Math.max(0, st.repath - 1 / 60);

  const moved = Math.hypot(me.entity.x - st.lastX, me.entity.y - st.lastY);
  st.lastX = me.entity.x;
  st.lastY = me.entity.y;
  if (moved < 2) st.stuck += 1 / 60;
  else st.stuck = 0;

  if (st.wp >= st.path.length || st.stuck > STUCK_SECONDS) {
    if (st.repath <= 0) repath();
  }

  let tx = goal.x;
  let ty = goal.y;
  while (st.wp < st.path.length) {
    const w = st.path[st.wp];
    if (Math.hypot(w.x - me.entity.x, w.y - me.entity.y) < WAYPOINT_EPS) st.wp++;
    else {
      tx = w.x;
      ty = w.y;
      break;
    }
  }

  const dx = tx - me.entity.x;
  const dy = ty - me.entity.y;
  engine.setKey("d", dx > 6);
  engine.setKey("a", dx < -6);
  engine.setKey("s", dy > 6);
  engine.setKey("w", dy < -6);
}

/** Sample a straight line and require every point to sit in walkable space. */
function lineInWalkable(rects: Rect[], from: Vec2, to: Vec2): boolean {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(dist / SAMPLE_STEP));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    if (!pointWalkable(x, y, rects)) return false;
  }
  return true;
}

function fmt(p: Vec2): string {
  return `(${p.x.toFixed(0)}, ${p.y.toFixed(0)})`;
}

let framesAudited = 0;
let movesAudited = 0;

/**
 * Verify one frame of positions against the frame before it. `prev` carries
 * each living actor's last position and is updated in place.
 */
function auditFrame(
  engine: GameEngine,
  rects: Rect[],
  prev: Map<string, Vec2>,
  dt: number,
): void {
  framesAudited++;
  const spawn = engine.map.pointsOfInterest.find((p) => p.kind === "spawn");
  for (const a of engine.actors) {
    if (!a.alive) {
      prev.delete(a.key);
      continue;
    }
    const cur: Vec2 = { x: a.entity.x, y: a.entity.y };
    const before = prev.get(a.key);
    prev.set(a.key, cur);

    // 1. The actor's position itself must be walkable by the game's own test.
    if (!canStand(engine.map, cur.x, cur.y, a.entity.radius)) {
      fail(
        `${a.name} stands inside a wall at ${fmt(cur)} (radius ${a.entity.radius}) ` +
          `at t=${engine.time.toFixed(1)}`,
      );
      continue;
    }
    if (!before) continue;

    // 2. The displacement must be physically possible for this actor's speed
    //    in one tick — collision never covers more ground than the requested
    //    step, so anything faster is a teleport, not walking.
    const maxStep = a.entity.speed * dt + STEP_SLACK;
    const dist = Math.hypot(cur.x - before.x, cur.y - before.y);

    // 3. Teleport classification: seating and venting are intended; anything
    //    else is an unexplained relocation and fails.
    if (dist > maxStep) {
      if (engine.phase === "meeting") {
        // Seating is a teleport by design, but it must land at the table.
        if (spawn && Math.hypot(cur.x - spawn.x, cur.y - spawn.y) > SEAT_RADIUS) {
          fail(
            `${a.name} seated ${Math.hypot(cur.x - spawn.x, cur.y - spawn.y).toFixed(0)}u ` +
              `from the meeting table at ${fmt(cur)} (t=${engine.time.toFixed(1)})`,
          );
        }
        continue;
      }
      const ventFrom = nearestPoi(engine.map, "vent", before.x, before.y);
      const ventTo = nearestPoi(engine.map, "vent", cur.x, cur.y);
      const isVentTravel =
        a.role === "imposter" &&
        ventFrom !== null &&
        ventTo !== null &&
        ventFrom.id !== ventTo.id &&
        Math.hypot(ventFrom.x - before.x, ventFrom.y - before.y) < 60 &&
        Math.hypot(ventTo.x - cur.x, ventTo.y - cur.y) < 60;
      if (isVentTravel) continue; // intended fast travel
      if (!lineInWalkable(rects, before, cur)) {
        fail(
          `${a.name} relocated THROUGH a wall: ${fmt(before)} -> ${fmt(cur)} ` +
            `(${dist.toFixed(0)}u) at t=${engine.time.toFixed(1)}`,
        );
      } else {
        fail(
          `${a.name} unexplained teleport: ${fmt(before)} -> ${fmt(cur)} ` +
            `(${dist.toFixed(0)}u) at t=${engine.time.toFixed(1)}`,
        );
      }
      continue;
    }

    movesAudited++;
  }
}

// ---------------------------------------------------------------------------
// Static geometry checks
// ---------------------------------------------------------------------------

console.log("=== Static geometry ===");
{
  const rects = walkableRects(UMBRA_DECK_MAP);
  for (const radius of [15, 16]) {
    for (const poi of UMBRA_DECK_MAP.pointsOfInterest) {
      if (!canStand(UMBRA_DECK_MAP, poi.x, poi.y, radius)) {
        fail(`POI "${poi.id}" (${poi.label}) is not walkable for radius ${radius}`);
      }
    }
  }
  console.log(
    `  ${UMBRA_DECK_MAP.pointsOfInterest.length} POIs walkable for actor radii 15 and 16`,
  );

  for (const room of UMBRA_DECK_MAP.rooms) {
    const zone: Zone = {
      id: room.id,
      kind: "room",
      name: room.name,
      short: room.short,
      roomId: room.id,
      cx: room.x + room.w / 2,
      cy: room.y + room.h / 2,
      taskPoiIds: [],
      ventPoiIds: [],
    };
    const pt = standPoint(UMBRA_DECK_MAP, zone);
    if (!canStand(UMBRA_DECK_MAP, pt.x, pt.y, 15)) {
      fail(`stand point for zone "${room.id}" is not walkable`);
    }
  }
  console.log(`  ${UMBRA_DECK_MAP.rooms.length} zone stand points walkable`);

  // Tunneling probe: a "tunnelable pair" is two walkable standing spots whose
  // straight axis segment crosses non-walkable space. For such a pair, an
  // endpoint-only step of that length would cross the wall in one frame —
  // exactly the large-`dt` hazard. moveWithCollision sub-steps long moves, so
  // whatever distance it actually covers must always be collision-clean.
  const TUNNEL_STEPS = [13, 40, 70, 120];
  const SCAN_CELL = 8;
  for (const step of TUNNEL_STEPS) {
    let pairs = 0;
    let crossed = 0;
    for (let y = 0; y + step <= UMBRA_DECK_MAP.height; y += SCAN_CELL) {
      for (let x = 0; x + step <= UMBRA_DECK_MAP.width; x += SCAN_CELL) {
        for (const dir of [0, 1] as const) {
          const dx = dir === 0 ? step : 0;
          const dy = dir === 0 ? 0 : step;
          const qx = x + dx;
          const qy = y + dy;
          if (qy > UMBRA_DECK_MAP.height) continue;
          if (!canStand(UMBRA_DECK_MAP, x, y, 15)) continue;
          if (!canStand(UMBRA_DECK_MAP, qx, qy, 15)) continue;
          const samples = Math.max(2, Math.ceil(step / 1));
          let blocked = false;
          for (let i = 0; i <= samples; i++) {
            const t = i / samples;
            if (!pointWalkable(x + dx * t, y + dy * t, rects)) {
              blocked = true;
              break;
            }
          }
          if (!blocked) continue;
          pairs++;
          const end = moveWithCollision(UMBRA_DECK_MAP, { x, y }, dx, dy, 15);
          if (!lineInWalkable(rects, { x, y }, end)) {
            crossed++;
            if (crossed <= 3) {
              fail(
                `movement tunneled a wall at step ${step}px: ` +
                  `(${x}, ${y}) -> (${end.x.toFixed(0)}, ${end.y.toFixed(0)})`,
              );
            }
          }
        }
      }
    }
    console.log(
      `  step ${String(step).padStart(3)}px: ${pairs} wall-straddling position pairs, ` +
        `${crossed} tunneled`,
    );
  }
}

// ---------------------------------------------------------------------------
// Full-match replays
// ---------------------------------------------------------------------------

function runMatch(
  label: string,
  playerIsImposter: boolean,
  seed: number,
  dt: number,
): void {
  console.log(
    `\n=== ${label} (seed ${seed}, dt=${(dt * 1000).toFixed(0)}ms) ===`,
  );
  const engine = new GameEngine({ playerIsImposter, seed, llm: false });
  engine.begin();
  const rects = walkableRects(engine.map);
  const prev = new Map<string, Vec2>();
  const maxSeconds = 900;

  while (engine.phase !== "ended" && engine.time < maxSeconds) {
    drivePlayer(engine);
    if (engine.activeTask) engine.completeActiveTask();
    if (engine.phase === "meeting") {
      const m = engine.snapshot().meeting;
      if (m?.stage === "discussion" && m.secondsLeft <= 18) engine.advanceMeeting();
      if (m?.stage === "voting" && m.myVote === null) {
        const target = m.speakers.find((s) => !s.isPlayer && s.alive);
        engine.playerVote(target ? target.key : null);
      }
    }
    engine.tick(dt);
    auditFrame(engine, rects, prev, dt);
  }

  console.log(
    `  ${engine.phase === "ended" ? "ended" : "capped"} t=${engine.time.toFixed(0)}s ` +
      `winner=${engine.winner} meetings=${engine.meetingsHeld} ` +
      `frames=${framesAudited} moves-verified=${movesAudited}`,
  );
}

framesAudited = 0;
movesAudited = 0;
runMatch("Match A: player is crew", false, 42, 1 / 60);
runMatch("Match B: player is imposter", true, 777, 1 / 60);
runMatch("Match C: browser worst-case frame", false, 42, 0.05);
runMatch("Match D: hostile oversized tick", false, 42, 0.3);

console.log(
  `\nAudited ${framesAudited} frames / ${movesAudited} continuous moves ` +
    `across 4 full matches (60Hz, 50ms and 300ms ticks).`,
);

if (failures > 0) {
  console.error(`\n${failures} wall-integrity failure(s)`);
  process.exit(1);
}
console.log("Wall integrity passed ✓ — no AI crossed or stood inside geometry.");
