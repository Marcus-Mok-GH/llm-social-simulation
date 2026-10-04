/**
 * Touch input checks.
 *
 * The mobile layout adds an on-screen joystick that writes an analog vector to
 * the engine. This asserts the vector actually moves the player, that releasing
 * it stops the player, and that a held movement key still wins over the stick
 * so the two input paths can coexist.
 *
 * Run: bun scripts/validate-touch.ts
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { GameEngine } from "../src/game/engine";
import { TouchControls } from "../src/components/TouchControls";

let bad = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const step = (engine: GameEngine, ticks = 30) => {
  for (let i = 0; i < ticks; i++) engine.tick(1 / 60);
};

// 1. stick pushed right moves the player
const engine = new GameEngine({ playerIsImposter: false, llm: false });
engine.begin();
const start = { x: engine.player.x, y: engine.player.y };
engine.touchMove = { x: 1, y: 0 };
step(engine);
const movedX = engine.player.x - start.x;
check("joystick moves the player", movedX > 20, `dx=${movedX.toFixed(1)}`);

// 2. releasing the stick stops the player
engine.touchMove = null;
const rest = { x: engine.player.x, y: engine.player.y };
step(engine);
const drift = Math.hypot(engine.player.x - rest.x, engine.player.y - rest.y);
check("releasing the stick stops movement", drift < 0.001, `drift=${drift.toFixed(4)}`);

// 3. a held key overrides the stick (keyboard + touch can coexist)
engine.touchMove = { x: 0, y: 1 };
engine.setKey("w", true);
const before = { x: engine.player.x, y: engine.player.y };
step(engine);
const movedY = engine.player.y - before.y;
check("held movement key overrides the stick", movedY < -5, `dy=${movedY.toFixed(1)}`);
engine.setKey("w", false);
engine.touchMove = null;

// 4. the engine normalizes stick direction, so a diagonal isn't faster.
//    Measure both over a short, unobstructed hop so walls don't skew it.
const travel = (vector: { x: number; y: number }, ticks: number) => {
  const e = new GameEngine({ playerIsImposter: false, llm: false });
  e.begin();
  const from = { x: e.player.x, y: e.player.y };
  e.touchMove = vector;
  step(e, ticks);
  return Math.hypot(e.player.x - from.x, e.player.y - from.y);
};
const straight = travel({ x: 1, y: 0 }, 6);
const diagonal = travel({ x: 1, y: 1 }, 6);
check(
  "diagonal stick speed matches straight speed",
  straight > 20 && Math.abs(diagonal - straight) / straight < 0.02,
  `diag=${diagonal.toFixed(2)} straight=${straight.toFixed(2)}`,
);

// 5. `interact()` tells the caller when it took over the screen. The touch
//    UI uses that to decide whether it may keep "E" held: a task or meeting
//    unmounts the controls, so latching the key there would leave it stuck.
const atPoi = (id: string) => {
  const engine = new GameEngine({ playerIsImposter: false, llm: false });
  engine.begin();
  const poi = engine.map.pointsOfInterest.find((p) => p.id === id);
  if (!poi) throw new Error(`missing POI ${id}`);
  engine.player.x = poi.x;
  engine.player.y = poi.y;
  return engine;
};

const taskEngine = atPoi("task_mess");
taskEngine.interact();
check(
  "interacting with a task reports the open task",
  Boolean(taskEngine.activeTask) && taskEngine.meeting === null,
);

const meetingEngine = atPoi("emergency");
meetingEngine.interact();
check(
  "interacting with the beacon reports the open meeting",
  meetingEngine.meeting !== null,
);

const repairEngine = atPoi("sab_power");
repairEngine.interact();
check(
  "interacting at a repair console keeps hold-to-repair available",
  repairEngine.activeTask === null && repairEngine.meeting === null,
);

// 6. the thumb controls show the right actions for the player's role
const render = (playerIsImposter: boolean) => {
  const engine = new GameEngine({ playerIsImposter, llm: false });
  engine.begin();
  return renderToString(
    createElement(TouchControls, {
      engine,
      snap: engine.snapshot(),
      onAction: () => {},
    }),
  );
};

const crew = render(false);
check(
  "touch controls offer USE and REPORT to the crew",
  crew.includes('aria-label="Interact"') && crew.includes('aria-label="Report"'),
);
check(
  "touch controls hide kill/sabotage from the crew",
  !crew.includes('aria-label="Kill"') && !crew.includes('aria-label="Sabotage"'),
);

const imposter = render(true);
check(
  "touch controls offer kill and sabotage to the imposter",
  imposter.includes('aria-label="Kill"') &&
    imposter.includes('aria-label="Sabotage"'),
);
check(
  "touch controls always provide the joystick",
  crew.includes("Virtual joystick") && imposter.includes("Virtual joystick"),
);

console.log(bad > 0 ? "\nTouch input checks failed" : "\nTouch input checks passed ✓");
process.exit(bad > 0 ? 1 : 0);
