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
  buildView(actor: unknown): { interactables: Interactable[]; system_message: string | null };
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

// --- 7. Sanity: the tuning constants the messages describe are the live ones -----------------
check(INTERACT_RANGE > 0 && KILL_RANGE > 0 && KILL_COOLDOWN > 0, "interaction constants are positive");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nInteraction pipeline checks passed ✓");
