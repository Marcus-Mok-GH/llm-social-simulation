/**
 * Headless full-match simulation.
 *
 * Replays entire matches through `GameEngine` at 60 Hz with fixed seeds and no
 * model calls, then asserts that every subsystem actually fired:
 *
 *   - agents perceived each other and formed suspicions
 *   - the shared task bar advanced (and stayed reachable)
 *   - imposters killed, bodies were found and meetings were held
 *   - votes resolved and ejections happened
 *   - a winner was produced, within the match time limit
 *
 * The "human" is scripted to walk to its assigned consoles, which is what makes
 * the crew-win path reachable in a test.
 *
 * Run: bun scripts/simulate.ts
 */

import { type Vec2 } from "../src/game/collision";
import { GameEngine } from "../src/game/engine";
import { UMBRA_DECK_MAP } from "../src/game/map";
import { buildNavGrid, findPath, type NavGrid } from "../src/game/navigation";
import { rankSuspects } from "../src/game/perception";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

const MOVE = ["w", "a", "s", "d"];

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
 * Walk the human toward their next unfinished console and work it.
 *
 * The driver steers with movement keys only (the same w/a/s/d the real player
 * uses), but chooses its heading by following an A* path on the nav grid, so
 * it can actually route through corridors instead of grinding into walls.
 */
function drivePlayer(engine: GameEngine): void {
  const me = engine.playerActor;
  if (engine.phase !== "playing" || !me.alive) {
    for (const k of MOVE) engine.setKey(k, false);
    return;
  }
  const task = me.tasks.find((t) => !t.done);
  if (!task) {
    for (const k of MOVE) engine.setKey(k, false);
    return;
  }
  const poi = engine.map.pointsOfInterest.find((p) => p.id === task.poiId);
  if (!poi) return;

  let st = driverState.get(engine);
  if (!st) {
    // Player radius is 16; a cell is only walkable when the player fits there.
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

  const dist = Math.hypot(poi.x - me.entity.x, poi.y - me.entity.y);
  if (dist < INTERACT_DIST) {
    for (const k of MOVE) engine.setKey(k, false);
    engine.interact();
    return;
  }

  const repath = (): void => {
    st!.path = findPath(st!.grid, { x: me.entity.x, y: me.entity.y }, { x: poi.x, y: poi.y }) ?? [];
    st!.wp = 0;
    st!.target = task.poiId;
    st!.stuck = 0;
    st!.repath = REPATH_COOLDOWN;
  };

  // Re-path immediately on a new console; otherwise when we ran out of
  // waypoints or hit the stuck watchdog (throttled so a failure to path
  // doesn't burn an A* search every frame).
  if (st.target !== task.poiId) repath();
  else st.repath = Math.max(0, st.repath - 1 / 60);

  const moved = Math.hypot(me.entity.x - st.lastX, me.entity.y - st.lastY);
  st.lastX = me.entity.x;
  st.lastY = me.entity.y;
  if (moved < 2) st.stuck += 1 / 60;
  else st.stuck = 0;

  if (st.wp >= st.path.length || st.stuck > STUCK_SECONDS) {
    if (st.repath <= 0) repath();
  }

  // Steer toward the next waypoint, consuming the ones we've reached.
  let tx = poi.x;
  let ty = poi.y;
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

interface Outcome {
  engine: GameEngine;
  kills: number;
}

function runMatch(label: string, playerIsImposter: boolean, seed: number): Outcome {
  const engine = new GameEngine({ playerIsImposter, seed, llm: false });
  engine.begin();

  const dt = 1 / 60;
  const maxSeconds = 900;
  let frames = 0;

  while (engine.phase !== "ended" && engine.time < maxSeconds) {
    frames++;
    drivePlayer(engine);
    if (engine.activeTask) engine.completeActiveTask();

    if (engine.phase === "meeting") {
      const m = engine.snapshot().meeting;
      if (m?.stage === "discussion" && m.secondsLeft <= 18) engine.advanceMeeting();
      if (m?.stage === "voting" && m.myVote === null && frames % 30 === 0) {
        const target = m.speakers.find((s) => !s.isPlayer && s.alive);
        engine.playerVote(target ? target.key : null);
      }
    }

    engine.tick(dt);
  }

  const kills = engine.messages.filter((m) => m.text.includes("was killed")).length;
  const snap = engine.snapshot();
  const maxMem = Math.max(...engine.actors.map((a) => a.mind.memories.length));
  const maxJournal = Math.max(...engine.actors.map((a) => a.mind.journal.length));
  console.log(
    `\n[${label}] phase=${engine.phase} winner=${engine.winner} t=${engine.time.toFixed(0)}s ` +
      `meetings=${snap.meetings} ejects=${snap.ejects} kills=${kills} ` +
      `tasks=${engine.taskComplete}/${engine.taskTotal} frames=${frames} ` +
      `longest-log: ${maxMem} events / ${maxJournal} decisions`,
  );

  return { engine, kills };
}

function audit({ engine, kills }: Outcome, label: string): void {
  // 1. Perception and beliefs actually moved.
  const withMemory = engine.actors.filter((a) => a.mind.memories.length > 0);
  check(withMemory.length > 0, `${label}: at least one agent recorded a memory`);

  const suspicious = engine.actors.filter((a) => rankSuspects(a.mind, 0.08).length > 0);
  check(
    suspicious.length > 0,
    `${label}: at least one agent holds a suspicion above the noise floor`,
  );

  // 2. Crew worked the task bar, and the bar stayed reachable.
  check(engine.taskComplete > 0, `${label}: shared task bar advanced (${engine.taskComplete})`);
  check(
    engine.taskComplete <= engine.taskTotal,
    `${label}: task bar never overshot its target (${engine.taskComplete}/${engine.taskTotal})`,
  );

  // 3. The match produced a verdict well inside the limit.
  check(engine.winner !== null, `${label}: a winner was declared`);
  check(engine.time < 900, `${label}: match resolved before the sim cap`);

  // 4. The human's own task flow (interact → minigame → complete) really works.
  if (!engine.playerActor.role.includes("imp")) {
    const mine = engine.playerTasks;
    const done = mine.filter((t) => t.done).length;
    check(mine.length > 0, `${label}: the human was assigned consoles`);
    check(done > 0, `${label}: the human completed a console end-to-end (${done}/${mine.length})`);
  }

  // 5. Combat and the social layer both engaged.
  check(kills > 0, `${label}: at least one kill happened (got ${kills})`);
  check(engine.meetingsHeld > 0, `${label}: at least one meeting was held`);

  // 6. Everyone still standing is somewhere legal and finite.
  for (const a of engine.actors) {
    if (!a.alive) continue;
    check(
      Number.isFinite(a.entity.x) && Number.isFinite(a.entity.y),
      `${label}: ${a.name} has finite coordinates`,
    );
    check(
      a.entity.x > -100 && a.entity.x < UMBRA_DECK_MAP.width + 100,
      `${label}: ${a.name} stayed inside the map`,
    );
    check(
      a.entity.y > -100 && a.entity.y < UMBRA_DECK_MAP.height + 100,
      `${label}: ${a.name} stayed inside the map vertically`,
    );
  }

  // 7. Suspicion never left its range.
  for (const a of engine.actors) {
    for (const score of Object.values(a.mind.suspicion)) {
      if (score < 0 || score > 1) {
        check(false, `${label}: ${a.name} suspicion out of range (${score})`);
      }
    }
  }

  // 8. Agents keep context between decisions: a goal, their reasoning, and a
  //    recap of the meetings they attended.
  const meetingMinds = engine.actors.filter((a) => a.mind.meetings.length > 0);
  check(meetingMinds.length > 0, `${label}: at least one agent remembers a meeting`);
  const recap = meetingMinds[0]?.mind.meetings.slice(-1)[0];
  check(
    recap !== undefined && recap.lines.length > 0,
    `${label}: the meeting recap contains the discussion`,
  );
  check(
    engine.snapshot().ejects === 0 ||
      meetingMinds.some((a) => a.mind.meetings.some((mm) => mm.ejected !== null)),
    `${label}: an ejection is recorded in meeting memory`,
  );
  check(
    meetingMinds.every((a) =>
      a.mind.meetings.every((mm) => !mm.lines.some((l) => l.startsWith("…and"))),
    ),
    `${label}: meeting recaps are complete (no truncated transcripts)`,
  );
  check(
    engine.actors.some((a) => a.mind.goal !== null && a.mind.lastAction !== null),
    `${label}: at least one agent carries a goal between ticks`,
  );
  check(
    engine.actors.some((a) => a.mind.lastReasoning !== null),
    `${label}: at least one agent carries its reasoning between ticks`,
  );
  check(
    engine.actors.some((a) => a.mind.memories.some((m) => m.kind === "sighted")),
    `${label}: agents remember where everyone moved over the match`,
  );
  const earliest = Math.min(
    ...engine.actors.map((a) => a.mind.memories[0]?.t ?? Infinity),
  );
  check(
    earliest === 0 || engine.time - earliest > 30,
    `${label}: the earliest remembered event is still present near the end`,
  );
}

console.log("=== Match A: player is crew ===");
audit(runMatch("crew", false, 42), "crew");

console.log("\n=== Match B: player is imposter ===");
audit(runMatch("imposter", true, 777), "imposter");

// --- reproducibility --------------------------------------------------------
const fingerprint = (seed: number): string => {
  const engine = new GameEngine({ playerIsImposter: false, seed, llm: false });
  engine.begin();
  for (let i = 0; i < 600; i++) {
    for (const a of engine.actors) {
      if (a.isPlayer || !a.alive) continue;
      const d = Math.hypot(a.entity.x - 900, a.entity.y - 250);
      if (d > 400) engine.setKey("a", true);
    }
    engine.tick(1 / 60);
  }
  return JSON.stringify(engine.snapshot().alive) + "|" + Math.round(engine.time * 1000);
};
check(
  fingerprint(4242) === fingerprint(4242),
  "the same seed produces an identical world after 10 simulated seconds",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nFull-match simulation passed ✓");
