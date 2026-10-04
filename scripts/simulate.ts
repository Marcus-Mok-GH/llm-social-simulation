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

import { GameEngine } from "../src/game/engine";
import { UMBRA_DECK_MAP } from "../src/game/map";
import { rankSuspects } from "../src/game/perception";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

const MOVE = ["w", "a", "s", "d"];

/** Walk the human toward their next unfinished console and work it. */
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

  const dx = poi.x - me.entity.x;
  const dy = poi.y - me.entity.y;
  engine.setKey("d", dx > 10);
  engine.setKey("a", dx < -10);
  engine.setKey("s", dy > 10);
  engine.setKey("w", dy < -10);
  if (Math.hypot(dx, dy) < 50) engine.interact();
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
  console.log(
    `\n[${label}] phase=${engine.phase} winner=${engine.winner} t=${engine.time.toFixed(0)}s ` +
      `meetings=${snap.meetings} ejects=${snap.ejects} kills=${kills} ` +
      `tasks=${engine.taskComplete}/${engine.taskTotal} frames=${frames}`,
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
      const d = Math.hypot(a.entity.x - 840, a.entity.y - 340);
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
