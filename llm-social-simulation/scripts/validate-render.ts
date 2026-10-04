/**
 * Headless smoke test for the canvas renderer. Runs drawMap against a recording
 * mock 2D context (no DOM needed) to prove the drawing code executes
 * end-to-end and actually issues draw calls for rooms / corridors / POIs, and
 * for the player when one is supplied.
 *
 * Run: bun scripts/validate-render.ts
 */
import { createCrewmates } from "../src/game/crewmate";
import { createImposters } from "../src/game/imposter";
import { UMBRA_DECK_MAP as map } from "../src/game/map";
import { createPlayer } from "../src/game/player";
import { drawMap } from "../src/game/render/renderMap";

function makeCtx(calls: string[]): CanvasRenderingContext2D {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop: string) {
      const value = target[prop];
      if (typeof value === "function") return value;
      return (...args: unknown[]) => {
        calls.push(prop);
        void args;
        return undefined;
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  };
  const base: Record<string, unknown> = { canvas: { width: 960, height: 600 } };
  return new Proxy(base, handler) as unknown as CanvasRenderingContext2D;
}

const count = (calls: string[], name: string) =>
  calls.filter((c) => c === name).length;

// --- Pass 1: map only -------------------------------------------------------
const mapCalls: string[] = [];
try {
  drawMap(makeCtx(mapCalls), map, 960, 600, 1);
} catch (err) {
  console.error("drawMap (map only) threw:", err);
  process.exit(1);
}

const required = ["fillRect", "strokeRect", "fillText", "arc", "arcTo", "fill", "stroke"] as const;
const missing = required.filter((name) => count(mapCalls, name) === 0);
if (missing.length) {
  console.error(`drawMap did not call: ${missing.join(", ")}`);
  process.exit(1);
}

const minFills = map.rooms.length + map.corridors.length;
if (count(mapCalls, "fill") < minFills) {
  console.error(`expected >= ${minFills} fill() calls, got ${count(mapCalls, "fill")}`);
  process.exit(1);
}
if (count(mapCalls, "fillText") < map.rooms.length) {
  console.error(`expected >= ${map.rooms.length} label fillText() calls`);
  process.exit(1);
}
if (count(mapCalls, "setTransform") === 0) {
  console.error("drawMap never called setTransform");
  process.exit(1);
}

// --- Pass 2: map + player + crewmates --------------------------------------
const player = createPlayer(map);
const crewmates = createCrewmates(map, 3);
// Force one crewmate into the working state so the task progress ring draws.
crewmates[0].state = "working";
crewmates[0].taskProgress = 0.5;
const imposters = createImposters(map, 2);
// Exercise the venting branch (alpha fade) and the stalking link.
imposters[0].state = "venting";
imposters[1].state = "stalking";
imposters[1].targetCrewmateId = crewmates[1].id;
const withPlayer: string[] = [];
try {
  drawMap(makeCtx(withPlayer), map, 960, 600, 1, { player, crewmates, imposters });
} catch (err) {
  console.error("drawMap (with player + crewmates + imposters) threw:", err);
  process.exit(1);
}

// Player = shadow (ellipse) + 3 arcs (body, visor, ring).
if (count(withPlayer, "ellipse") === 0) {
  console.error("drawMap did not draw the player shadow (ellipse)");
  process.exit(1);
}
if (count(withPlayer, "arc") <= count(mapCalls, "arc")) {
  console.error("drawMap did not draw the player body (arc count unchanged)");
  process.exit(1);
}
// Player + crewmate + imposter shadows = ellipse per actor.
if (count(withPlayer, "ellipse") < 1 + crewmates.length + imposters.length) {
  console.error(
    `expected >= ${1 + crewmates.length + imposters.length} ellipses, got ${count(withPlayer, "ellipse")}`,
  );
  process.exit(1);
}
// Imposters use save/restore for the venting alpha and the stalk link dash.
if (count(withPlayer, "save") < imposters.length || count(withPlayer, "restore") < imposters.length) {
  console.error("expected save/restore calls for the imposter draws");
  process.exit(1);
}
if (count(withPlayer, "setLineDash") === 0) {
  console.error("expected a dashed stalking link (setLineDash)");
  process.exit(1);
}

console.log("Renderer smoke test passed ✓");
console.log(`  map pass:    ${mapCalls.length} calls, fill=${count(mapCalls, "fill")}, arcs=${count(mapCalls, "arc")}`);
console.log(
  `  actors pass: ${withPlayer.length} calls, arcs=${count(withPlayer, "arc")}, ellipse=${count(withPlayer, "ellipse")}`,
);
