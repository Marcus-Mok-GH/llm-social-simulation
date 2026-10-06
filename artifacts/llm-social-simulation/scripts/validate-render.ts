/**
 * Headless smoke test for the canvas renderer. Runs drawMap against a recording
 * mock 2D context (no DOM needed) to prove the drawing code executes
 * end-to-end and actually issues draw calls for the deck artwork / POIs, for
 * the actors, and for the fog layer.
 *
 * Run: bun scripts/validate-render.ts
 */
import { createCrewmates } from "../src/game/crewmate";
import { createImposters } from "../src/game/imposter";
import { UMBRA_DECK_MAP as map } from "../src/game/map";
import { createPlayer } from "../src/game/player";
import {
  CAM_ZOOM,
  computeFollowTransform,
  computeTransform,
  drawMap,
} from "../src/game/render/renderMap";
import { buildVisibilityGrid, castVision } from "../src/game/vision";

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

// --- Pass 1: the deck artwork + markers ------------------------------------
// The renderer paints the official artwork as the deck, so it is handed a
// stand-in image source; only drawImage's geometry matters here.
const artwork = { width: 1800, height: 1007 } as unknown as CanvasImageSource;
const mapCalls: string[] = [];
try {
  drawMap(makeCtx(mapCalls), map, 960, 600, 1, { background: artwork });
} catch (err) {
  console.error("drawMap (deck artwork) threw:", err);
  process.exit(1);
}

const required = ["fillRect", "arc", "fill", "stroke"] as const;
const missing = required.filter((name) => count(mapCalls, name) === 0);
if (missing.length) {
  console.error(`drawMap did not call: ${missing.join(", ")}`);
  process.exit(1);
}

if (count(mapCalls, "drawImage") === 0) {
  console.error("drawMap never drew the deck artwork (drawImage)");
  process.exit(1);
}
if (count(mapCalls, "fill") < map.pointsOfInterest.length) {
  console.error(
    `expected >= ${map.pointsOfInterest.length} fill() calls, got ${count(mapCalls, "fill")}`,
  );
  process.exit(1);
}
// The official artwork already names every room, so the renderer must not
// paint room-name/size text over the deck.
if (count(mapCalls, "fillText") !== 0) {
  console.error(`expected 0 label fillText() calls on the deck, got ${count(mapCalls, "fillText")}`);
  process.exit(1);
}
if (count(mapCalls, "setTransform") === 0) {
  console.error("drawMap never called setTransform");
  process.exit(1);
}

// --- Pass 2: actors, role-neutral ------------------------------------------
const player = createPlayer(map);
const crewmates = createCrewmates(map, 3);
// Force one crewmate into the working state so the task progress ring draws.
crewmates[0].state = "working";
crewmates[0].taskProgress = 0.5;
const imposters = createImposters(map, 2);

const withActors: string[] = [];
try {
  drawMap(makeCtx(withActors), map, 960, 600, 1, { player, crewmates, imposters });
} catch (err) {
  console.error("drawMap (with actors) threw:", err);
  process.exit(1);
}

if (count(withActors, "ellipse") === 0) {
  console.error("drawMap did not draw actor shadows (ellipse)");
  process.exit(1);
}
if (count(withActors, "arc") <= count(mapCalls, "arc")) {
  console.error("drawMap did not draw the player body (arc count unchanged)");
  process.exit(1);
}
// Every actor is tagged with their name (the crew still need to be told which
// avatar is which), so the actors pass is where screen-space text belongs.
if (count(withActors, "fillText") < 1 + crewmates.length + imposters.length) {
  console.error("drawMap did not tag the actors with their names");
  process.exit(1);
}
// Player + crew + imposters all get a shadow. An imposter is still on the
// deck (only a venting one is hidden).
const visibleActors = 1 + crewmates.length + imposters.length;
if (count(withActors, "ellipse") !== visibleActors) {
  console.error(
    `expected ${visibleActors} actor shadows, got ${count(withActors, "ellipse")}`,
  );
  process.exit(1);
}
// Imposters must not be marked out of the box: no reveal → no red marker.
// The only dashes on a normal frame are the spawn marker and its reset.
if (count(withActors, "setLineDash") !== count(mapCalls, "setLineDash")) {
  console.error("actors drew a dashed overlay without analyst view");
  process.exit(1);
}

// --- Pass 3: analyst view reveals the tells ---------------------------------
const revealed: string[] = [];
try {
  drawMap(makeCtx(revealed), map, 960, 600, 1, { player, crewmates, imposters, revealRoles: true });
} catch (err) {
  console.error("drawMap (analyst view) threw:", err);
  process.exit(1);
}
// The analyst tell is now the red marker above each imposter — an extra fill.
if (count(revealed, "fill") <= count(withActors, "fill")) {
  console.error("analyst view did not mark the imposters");
  process.exit(1);
}

// --- Pass 4: a venting imposter is inside the ducts, not on the deck --------
const hidden = createImposters(map, 1);
hidden[0].state = "venting";
const withHidden: string[] = [];
drawMap(makeCtx(withHidden), map, 960, 600, 1, { player, crewmates: [], imposters: hidden, revealRoles: true });
if (count(withHidden, "ellipse") !== 1) {
  console.error(
    `expected only the player shadow while an imposter vents, got ${count(withHidden, "ellipse")}`,
  );
  process.exit(1);
}

// --- Pass 5: fog of war -----------------------------------------------------
const grid = buildVisibilityGrid(map);
const polygon = castVision(grid, player.x, player.y, 400);
const fogged: string[] = [];
try {
  drawMap(makeCtx(fogged), map, 960, 600, 1, { player, fog: { polygon, grid } });
} catch (err) {
  console.error("drawMap (fog) threw:", err);
  process.exit(1);
}
if (count(fogged, "fill") <= count(mapCalls, "fill")) {
  console.error("fog layer did not fill the unlit region");
  process.exit(1);
}
if (polygon.length !== 360 * 2) {
  console.error(`expected 360 vision rays, got ${polygon.length / 2}`);
  process.exit(1);
}

// --- Pass 6: the player-following camera ------------------------------------
// The follow transform must zoom in over the whole-deck fit, keep the player
// centred when there is room to do so, and clamp at the deck edges instead of
// panning into the void. drawMap must route the fog polygon through the same
// transform as the world, so the lit region stays glued to the player.
let followFail = 0;
const checkFollow = (cond: boolean, msg: string): void => {
  if (!cond) {
    followFail++;
    console.error(`  ✗ ${msg}`);
  }
};

const baseScale = computeTransform(map, 960, 600).scale;
const centre = computeFollowTransform(map, 960, 600, { x: map.width / 2, y: map.height / 2 });
checkFollow(
  Math.abs(centre.scale - baseScale * CAM_ZOOM) < 1e-9,
  `camera zooms in exactly ${CAM_ZOOM}× the whole-deck fit`,
);
checkFollow(
  Math.abs(centre.offsetX + (map.width / 2) * centre.scale - 480) < 1e-9 &&
    Math.abs(centre.offsetY + (map.height / 2) * centre.scale - 300) < 1e-9,
  "a centred target projects back to the screen centre",
);

const corner = computeFollowTransform(map, 960, 600, { x: 0, y: 0 });
checkFollow(
  Math.abs(corner.offsetX) < 1e-9,
  "clamps at the west edge (no void left of the hull)",
);
checkFollow(
  Math.abs(corner.offsetY) < 1e-9,
  "clamps at the north edge",
);
const farCorner = computeFollowTransform(map, 960, 600, { x: map.width, y: map.height });
checkFollow(
  Math.abs(farCorner.offsetX + map.width * farCorner.scale - 960) < 1e-9,
  "clamps at the east edge",
);
checkFollow(
  Math.abs(farCorner.offsetY + map.height * farCorner.scale - 600) < 1e-9,
  "clamps at the south edge",
);
const wide = computeFollowTransform(map, 4800, 600, { x: 123, y: 456 });
checkFollow(
  Math.abs(wide.offsetX + (map.width / 2) * wide.scale - 2400) < 1e-9,
  "a view wider than the deck centres the X axis",
);
const zoomedOut = computeFollowTransform(map, 960, 600, { x: 123, y: 456 }, 0.5);
checkFollow(
  Math.abs(zoomedOut.scale - baseScale) < 1e-9,
  "zoom below 1 clamps to the whole-deck fit",
);

const followed: string[] = [];
try {
  drawMap(makeCtx(followed), map, 960, 600, 1, {
    background: artwork,
    player,
    crewmates,
    imposters,
    fog: { polygon, grid },
    camera: { x: player.x, y: player.y },
  });
} catch (err) {
  console.error("drawMap (follow camera) threw:", err);
  process.exit(1);
}
const baseFogFills = count(withActors, "fill");
checkFollow(
  count(followed, "fill") > baseFogFills,
  "follow-camera pass still fills the fog region",
);
// Headless runs have no DOM, so the explored layer is skipped and only the
// deck artwork drawImage survives — assert that, not a browser-specific 2.
checkFollow(count(followed, "drawImage") >= 1, "follow-camera pass still draws the deck artwork");
checkFollow(
  count(followed, "setTransform") >= 3,
  "follow-camera pass issues world, screen and fog transforms",
);
if (followFail > 0) {
  console.error(`follow-camera checks failed: ${followFail}`);
  process.exit(1);
}

console.log("Renderer smoke test passed ✓");
console.log(`  map pass:    ${mapCalls.length} calls, fill=${count(mapCalls, "fill")}, drawImage=${count(mapCalls, "drawImage")}, arcs=${count(mapCalls, "arc")}`);
console.log(
  `  actors pass: ${withActors.length} calls, arcs=${count(withActors, "arc")}, ellipse=${count(withActors, "ellipse")}`,
);
console.log(`  fog pass:    ${fogged.length} calls, polygon=${polygon.length / 2} rays`);
