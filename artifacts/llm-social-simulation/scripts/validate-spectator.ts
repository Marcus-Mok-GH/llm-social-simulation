/**
 * Headless validation of spectator mode and the agent thought feed.
 *
 * Spectator: the player departs the living roster (the dead-player path) and
 * must not be able to move, interact, kill, report, sabotage, speak or vote —
 * while the AI match keeps running. Full vision itself is a renderer concern
 * (the fog layer is skipped when `engine.spectator` is set); here we assert
 * the snapshot flag the renderer gates on.
 *
 * Thought feed: `recordDecision()` must ring-buffer every AI decision (action
 * + reasoning), evict old entries once full, and keep ids strictly increasing.
 *
 * Everything runs at the engine's native 1/60 step — coarse steps are known
 * to break the walkers (a 95u step cannot clear doorways), so every timing
 * assertion below would be meaningless at any other dt.
 *
 * Run: bun scripts/validate-spectator.ts
 */
import { GameEngine } from "../src/game/engine";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

const STEP = 1 / 60;

/**
 * Advance the match by `seconds` at the native step, polling `onPoll` with a
 * fresh snapshot every half second of game time (so meeting views and task
 * progress are observed while they are live, not just at the end).
 */
function run(engine: GameEngine, seconds: number, onPoll?: (s: ReturnType<GameEngine["snapshot"]>) => void): void {
  const total = Math.round(seconds / STEP);
  for (let i = 0; i < total; i++) {
    engine.tick(STEP);
    if (onPoll && i % 30 === 0) onPoll(engine.snapshot());
  }
}

// ---------------------------------------------------------------------------
// 1. Spectator mode: blocked interaction, running match
// ---------------------------------------------------------------------------
console.log("spectator mode");
{
  const engine = new GameEngine({ llm: false });
  engine.begin(true);
  const snap = engine.snapshot();

  check(snap.spectator === true, "snapshot reports spectator mode");
  check(engine.playerActor.alive === false, "player has departed the living roster");
  check(snap.prompt === "SPECTATING — full station vision", "prompt announces full station vision");
  check(engine.log.some((l) => l.includes("spectating")), "station log notes the departure");

  // No movement: even a held key or a forced joystick vector must not budge
  // the ghost.
  const start = { x: engine.player.x, y: engine.player.y };
  engine.setKey("w", true);
  engine.setKey("d", true);
  engine.touchMove = { x: 1, y: 1 };
  run(engine, 2);
  check(
    engine.player.x === start.x && engine.player.y === start.y,
    "player avatar cannot move while spectating",
  );
  engine.setKey("w", false);
  engine.setKey("d", false);
  engine.touchMove = null;

  // Every interaction primitive must refuse.
  check(engine.triggerSabotage() === false, "sabotage refused while spectating");
  engine.interact();
  check(engine.activeTask === null, "interact opens no task while spectating");
  check(engine.playerKill() === false, "kill refused while spectating");
  check(engine.report() === false, "report refused while spectating");
  engine.playerSay("anyone else seeing this?");
  check(
    !engine.messages.some((m) => m.speakerKey === "player"),
    "player cannot speak in meetings while spectating",
  );
  engine.playerVote("crew:0");

  // The AI match keeps playing underneath. Poll meeting views while they are
  // live: a spectator must never be recorded as speaking or voting.
  let sawMeeting = false;
  let meetingClean = true;
  run(engine, 40, (s) => {
    if (!s.meeting) return;
    sawMeeting = true;
    if (s.meeting.myVote !== null || s.meeting.messages.some((m) => m.kind === "player")) {
      meetingClean = false;
    }
  });
  check(meetingClean, "spectator never speaks or votes in any AI meeting");
  if (!sawMeeting) console.log("  (no AI meeting occurred — the vote UI path is covered by the snapshot guards)");
  check(
    engine.actors.some((a) => !a.isPlayer && a.mind.journal.length > 0),
    "AI agents keep making decisions",
  );
  check(engine.taskComplete >= 1, "AI crew complete real tasks without the player");
  check(engine.snapshot().spectator === true, "spectator flag persists through the match");
}

// ---------------------------------------------------------------------------
// 2. Thought feed: ring buffer collects reasoning and evicts when full
// ---------------------------------------------------------------------------
console.log("thought feed");
{
  const engine = new GameEngine({ llm: false });
  engine.begin(true);
  run(engine, 40);

  const feed = engine.snapshot().thoughts;
  check(feed.length > 0, "feed collects decisions");
  check(
    feed.every((t) => t.action.length > 0 && t.name.length > 0 && t.id > 0),
    "every entry carries an actor, action and id",
  );
  check(
    feed.some((t) => (t.reasoning ?? "").length > 0),
    "entries carry the agent's own reasoning",
  );
  check(
    feed.every((t, i) => i === 0 || feed[i - 1].t <= t.t),
    "entries are in chronological order",
  );
  check(feed.length === 24, `feed fills to the cap (length ${feed.length} === 24)`);
  check(feed[0].id > 1, `oldest entries were evicted (first id ${feed[0].id} > 1)`);
  check(
    feed.every((t, i) => i === 0 || feed[i - 1].id < t.id),
    "ids stay strictly increasing across eviction",
  );
}

// ---------------------------------------------------------------------------
// 3. Entering mid-match + normal mode regression
// ---------------------------------------------------------------------------
console.log("mid-match entry + regression");
{
  const engine = new GameEngine({ llm: false });
  engine.begin(false);
  check(engine.snapshot().spectator === false, "normal match is not in spectator mode");

  // Movement still works in a normal match.
  const startY = engine.player.y;
  engine.setKey("w", true);
  run(engine, 1);
  engine.setKey("w", false);
  check(engine.player.y < startY, "player still moves in a normal match");

  // Leave mid-match, then confirm the same guarantees as a full spectator run.
  engine.enterSpectator();
  check(engine.playerActor.alive === false, "mid-match departure works");
  check(engine.snapshot().spectator === true, "mid-match departure sets the flag");
  const frozen = { x: engine.player.x, y: engine.player.y };
  engine.setKey("a", true);
  run(engine, 2);
  engine.setKey("a", false);
  check(
    engine.player.x === frozen.x && engine.player.y === frozen.y,
    "no movement after mid-match departure",
  );
  run(engine, 10);
  check(engine.snapshot().thoughts.length > 0, "thought feed keeps updating after departure");
}

console.log(failures > 0 ? `\nFAILED: ${failures}` : "\nall spectator + feed checks passed");
process.exit(failures > 0 ? 1 : 0);
