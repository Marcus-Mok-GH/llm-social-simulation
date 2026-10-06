/**
 * Headless check of the PLAN.md interaction pipeline.
 *
 * Interactions are explicit, validated actions: an agent asks to `INTERACT`
 * with a target, the engine re-checks distance, game state and line of sight,
 * and either performs the effect or records a reason that is delivered back to
 * the agent as `system_message` on its next turn. This script drives that
 * referee directly and asserts both the accept and the reject paths.
 *
 * Run: bun scripts/validate-interactions.ts
 */
import { GameEngine, INTERACT_RANGE, KILL_RANGE, KILL_COOLDOWN } from "../src/game/engine";
import { remember } from "../src/game/perception";
import type { Interactable, Intent } from "../src/ai/decision";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

/**
 * `applyIntent` / `buildView` are intentionally not part of the engine's public
 * API — only the decision loop calls them. This check reaches in the same way
 * the other scripts reach into engine state.
 */
interface EngineInternals {
  applyIntent(actor: unknown, intent: Intent): void;
  updateSabotage(dt: number): void;
  buildView(actor: unknown): {
    interactables: Interactable[];
    system_message: string | null;
    zones: { id: string; name: string }[];
    your_goal: string | null;
    last_reasoning: string | null;
    last_action: string | null;
    last_move: string | null;
    history: string[];
    decision_history: { at: string; goal: string; action: string; reasoning: string | null }[];
  };
}

const engine = new GameEngine({ playerIsImposter: false, seed: 5, llm: false });
engine.begin();
const internals = engine as unknown as EngineInternals;

const crew = engine.actors.find((a) => a.kind === "crew");
const imposter = engine.actors.find((a) => a.role === "imposter");
if (!crew || !imposter) {
  console.error("engine did not build a crewmate and an imposter");
  process.exit(1);
}

const task = crew.tasks.find((t) => !t.done);
if (!task) {
  console.error("crewmate had no assigned task");
  process.exit(1);
}
const poi = engine.map.pointsOfInterest.find((p) => p.id === task.poiId);
if (!poi) {
  console.error("task had no matching POI");
  process.exit(1);
}

// --- 1. A rejected action performs nothing and is explained ---------------------------------
// Park the agent far away from the console, then ask anyway.
crew.entity.x = -500;
crew.entity.y = -500;
internals.applyIntent(crew, { action: "INTERACT", target: task.poiId, interaction_type: "TASK" });
check(
  crew.actionFeedback?.startsWith("Action Failed:") === true,
  `out-of-range task is refused ("${crew.actionFeedback}")`,
);
check(!task.done, "the refused task did not complete");

// --- 2. Feedback is delivered once, as system_message ---------------------------------------
const view = internals.buildView(crew);
check(
  view.system_message?.startsWith("Action Failed:") === true,
  `feedback is delivered as system_message ("${view.system_message}")`,
);
check(crew.actionFeedback === null, "feedback is consumed exactly once");
check(
  internals.buildView(crew).system_message === null,
  "the same feedback is not repeated on the following turn",
);

// --- 3. A hallucinated target is refused, never trusted -------------------------------------
internals.applyIntent(crew, { action: "INTERACT", target: "made_up_thing", interaction_type: "TASK" });
check(
  crew.actionFeedback?.includes("not one of your unfinished tasks") === true,
  `a hallucinated target is refused ("${crew.actionFeedback}")`,
);
internals.buildView(crew); // consume

// --- 4. A legal, in-range action executes ----------------------------------------------------
crew.entity.x = poi.x;
crew.entity.y = poi.y;
internals.applyIntent(crew, { action: "INTERACT", target: task.poiId, interaction_type: "TASK" });
check(crew.actionFeedback === null, "an in-range task is accepted with no feedback");
check((crew.entity as { state?: string }).state === "working", "the crewmate actually starts working");

// --- 5. Interactables are serialized for the current node ------------------------------------
crew.entity.x = poi.x;
crew.entity.y = poi.y;
const here = internals.buildView(crew).interactables;
const advertised = here.find((i) => i.type === "TASK" && i.id === task.poiId);
check(advertised !== undefined, "the console the agent stands at appears in interactables");
check(advertised?.in_range === true, "an adjacent console is advertised as in_range");
check(advertised?.status === "incomplete", `interactable carries its status ("${advertised?.status}")`);

// --- 6. Only a traitor can kill, and only up close, off cooldown -----------------------------
internals.applyIntent(imposter, { action: "INTERACT", target: crew.key, interaction_type: "KILL" });
check(
  imposter.actionFeedback?.includes("cooldown") === true,
  `kill is refused while cooling down ("${imposter.actionFeedback}")`,
);
internals.buildView(imposter);

imposter.killCooldown = 0;
imposter.entity.x = crew.entity.x + KILL_RANGE + 50;
imposter.entity.y = crew.entity.y;
internals.applyIntent(imposter, { action: "INTERACT", target: crew.key, interaction_type: "KILL" });
check(
  imposter.actionFeedback?.includes("too far") === true,
  `kill is refused out of range ("${imposter.actionFeedback}")`,
);
internals.buildView(imposter);

// A crewmate can never kill at all.
internals.applyIntent(crew, { action: "INTERACT", target: imposter.key, interaction_type: "KILL" });
check(
  crew.actionFeedback?.includes("not a traitor") === true,
  `a crewmate cannot kill ("${crew.actionFeedback}")`,
);

// --- 7. Decisions carry a goal and reasoning between iterations ------------------------------
const zone0 = internals.buildView(crew).zones[0];
internals.applyIntent(crew, { action: "MOVE", target: zone0.id, reasoning: "verify continuity" });
check(crew.mind.lastReasoning === "verify continuity", "reasoning is stored for the next turn");
check(
  crew.mind.goal !== null && crew.mind.goal.includes(zone0.name),
  `a durable goal is recorded ("${crew.mind.goal}")`,
);
check(crew.mind.lastMove === zone0.name, "the last destination zone is remembered");
const continuity = internals.buildView(crew);
check(continuity.your_goal === crew.mind.goal, "buildView feeds the goal back to the agent");
check(
  continuity.last_reasoning === "verify continuity",
  "buildView feeds the reasoning back to the agent",
);
check(continuity.last_move === zone0.name, "buildView feeds the last move back to the agent");

// --- 8. Memory is append-only for the whole match (nothing is evicted) -----------------------
const roomId = engine.map.rooms[0].id;
const before = crew.mind.memories.length;
for (let i = 0; i < 120; i++) {
  remember(crew.mind, {
    t: i,
    kind: "sighted",
    actorKey: "crew:1",
    roomId,
    text: `event ${i}`,
  });
}
check(
  crew.mind.memories.length === before + 120,
  "memory keeps every event it observes (no eviction)",
);
const fullHistory = internals.buildView(crew).history;
check(
  fullHistory.length === crew.mind.memories.length,
  "buildView serializes the complete match memory",
);
check(fullHistory.some((l) => l.includes("event 0")), "the very first event is still remembered");
check(fullHistory.some((l) => l.includes("event 119")), "the most recent event is remembered");

const decisionsBefore = crew.mind.journal.length;
const firstReasoning = crew.mind.journal[0]?.reasoning ?? null;
for (let i = 0; i < 60; i++) {
  internals.applyIntent(crew, { action: "MOVE", target: zone0.id, reasoning: `loop ${i}` });
}
const decisionsView = internals.buildView(crew);
check(
  crew.mind.journal.length === decisionsBefore + 60,
  "the decision journal keeps every decision (no eviction)",
);
check(
  decisionsView.decision_history.length === crew.mind.journal.length,
  "buildView serializes the whole decision journal",
);
check(
  decisionsView.decision_history[0]?.reasoning === firstReasoning,
  "the earliest decision is still remembered at the end of the match",
);

// --- 9. Sanity: the tuning constants the messages describe are the live ones -----------------
check(INTERACT_RANGE > 0 && KILL_RANGE > 0 && KILL_COOLDOWN > 0, "interaction constants are positive");

// --- 10. Reactor meltdown: two hands on two scanners, at the same time -----------------------
// A fresh engine so the sabotage runs against an untouched roster. `updateSabotage`
// is driven directly so the actors *stay* where this test puts them instead of
// wandering off and repairing it by accident.
const melt = new GameEngine({ playerIsImposter: false, seed: 11, llm: false });
melt.begin();
const meltInternals = melt as unknown as EngineInternals;
const pads = ["sab_hand_n", "sab_hand_s"].map(
  (id) => melt.map.pointsOfInterest.find((p) => p.id === id)!,
);
const crewmates = melt.actors.filter((a) => a.kind === "crew");

check(melt.triggerSabotage("meltdown"), "a traitor can trigger the reactor meltdown");
check(melt.sabotage?.kind === "meltdown", "the live sabotage is the meltdown");

// Everyone off the scanners, holds cleared, then one crewmate works one pad.
for (const a of melt.actors) {
  a.fixUntil = 0;
  a.entity.x = -500;
  a.entity.y = -500;
}
crewmates[0].entity.x = pads[0].x;
crewmates[0].entity.y = pads[0].y;
crewmates[0].fixUntil = melt.time + 20;
for (let i = 0; i < 12; i++) meltInternals.updateSabotage(0.5);
check(
  melt.sabotage !== null,
  "one scanner held alone never repairs the meltdown (it needs a second user)",
);

// Second crewmate on the other scanner: now both pads are held simultaneously.
crewmates[1].entity.x = pads[1].x;
crewmates[1].entity.y = pads[1].y;
crewmates[1].fixUntil = melt.time + 20;
for (let i = 0; i < 12 && melt.sabotage; i++) meltInternals.updateSabotage(0.5);
check(melt.sabotage === null, "both scanners held at once repair the meltdown");

// The beacon is locked while a critical sabotage is live.
melt.sabotageCooldown = 0;
melt.triggerSabotage("meltdown");
melt.actors[0].actionFeedback = null;
const beacon = melt.map.pointsOfInterest.find((p) => p.kind === "emergency")!;
meltInternals.applyIntent(melt.actors[0], {
  action: "INTERACT",
  target: beacon.id,
  interaction_type: "EMERGENCY",
});
check(
  melt.actors[0].actionFeedback?.includes("reactor is critical") === true,
  `the emergency beacon is locked during a meltdown ("${melt.actors[0].actionFeedback}")`,
);

// A body report is the escape hatch: it cancels the meltdown and opens a meeting.
melt.bodies.push({
  id: 999,
  key: "crew:9",
  name: "LOST",
  color: "#ffffff",
  x: 700,
  y: 700,
  roomId: melt.map.rooms[0].id,
});
const reporter = melt.actors.find((a) => a.kind === "crew")!;
reporter.entity.x = 704;
reporter.entity.y = 700;
meltInternals.applyIntent(reporter, {
  action: "INTERACT",
  target: "999",
  interaction_type: "REPORT",
});
check(melt.sabotage === null, "a body report cancels the live meltdown");
check(melt.meeting !== null, "the report opens a meeting");
check(
  melt.messages.some((m) => m.text.includes("interrupted the meltdown")),
  "the cancellation is announced to the crew",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nInteraction pipeline checks passed ✓");
