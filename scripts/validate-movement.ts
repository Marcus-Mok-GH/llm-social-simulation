/**
 * Headless validation of player movement + collision against the map.
 * Simulates the game loop with scripted/random inputs and asserts the player
 * always stays inside the walkable area and is blocked by walls.
 *
 * Run: bun scripts/validate-movement.ts
 */
import { canStand } from "../src/game/collision";
import { inputVectorFromKeys } from "../src/game/input";
import { UMBRA_DECK_MAP as map } from "../src/game/map";
import { createPlayer, updatePlayer, type MoveInput } from "../src/game/player";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

const STEP = 1 / 60;

/** Run `steps` ticks and report whether the player stayed walkable throughout. */
function run(player: ReturnType<typeof createPlayer>, input: MoveInput, steps: number): boolean {
  let ok = true;
  for (let i = 0; i < steps; i++) {
    updatePlayer(map, player, input, STEP);
    if (!canStand(map, player.x, player.y, player.radius)) ok = false;
  }
  return ok;
}

// 0. Input vector basics.
{
  const v = inputVectorFromKeys(new Set(["w", "d"]));
  check(Math.abs(Math.hypot(v.x, v.y) - 1) < 1e-9, "diagonal input is normalized");
  const still = inputVectorFromKeys(new Set());
  check(still.x === 0 && still.y === 0, "no keys => zero input");
  const left = inputVectorFromKeys(new Set(["arrowleft"]));
  check(left.x === -1 && left.y === 0, "arrowleft moves -x");
}

// 1. Spawn is valid.
const player = createPlayer(map);
check(canStand(map, player.x, player.y, player.radius), "spawn position is walkable");
const start = { x: player.x, y: player.y };

// 2. Move right until blocked by the Mess Hall's right wall (x ~ 1020).
check(run(player, { x: 1, y: 0 }, 240), "stayed walkable while moving right");
check(player.x > start.x + 50, "player actually moved right");
check(player.x <= 1020 - player.radius + 0.5, "right wall blocks the player (x <= 1004)");

// 3. Move left until blocked by the Mess Hall's left wall (x = 660).
check(run(player, { x: -1, y: 0 }, 600), "stayed walkable while moving left");
check(player.x >= 660 + player.radius - 0.5, "left wall blocks the player (x >= 676)");

// 4. Hard wall test: at y=150 there is no corridor, so the Mess Hall right wall
//    must stop the player at x = 1020 - radius.
{
  const p = createPlayer(map);
  p.x = 1000;
  p.y = 150;
  check(canStand(map, p.x, p.y, p.radius), "test start (1000,150) is walkable");
  run(p, { x: 1, y: 0 }, 120);
  check(p.x <= 1020 - p.radius + 0.5, "cannot cross the Mess Hall wall at y=150");
}

// 5. Corridor traversal: from the Mess Hall, go down through the corridor to
//    the Infirmary (x ~ 664..720) and confirm the player can pass the seam.
{
  const p = createPlayer(map);
  p.x = 690;
  p.y = 200;
  check(run(p, { x: 0, y: 1 }, 300), "stayed walkable while moving down into the corridor");
  check(p.y > 560, "player entered the Infirmary through the corridor (y > 560)");
}

// 6. Random walk: never leaves the walkable area or world bounds.
{
  const p = createPlayer(map);
  let seed = 123456789;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let ok = true;
  for (let i = 0; i < 4000; i++) {
    const input = { x: rand() * 2 - 1, y: rand() * 2 - 1 };
    updatePlayer(map, p, input, STEP);
    if (!canStand(map, p.x, p.y, p.radius)) ok = false;
    if (p.x < 0 || p.x > map.width || p.y < 0 || p.y > map.height) ok = false;
  }
  check(ok, "random walk stayed walkable and in bounds for 4000 ticks");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("Movement + collision checks passed ✓");
