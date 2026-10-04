import { canStand, moveWithCollision } from "./collision";
import type { GameMap } from "./map";

export interface Player {
  x: number;
  y: number;
  radius: number;
  /** World units per second. */
  speed: number;
  /** Unit vector the player is facing (last movement direction). */
  facingX: number;
  facingY: number;
  color: string;
}

export interface MoveInput {
  x: number;
  y: number;
}

export const PLAYER_RADIUS = 16;
export const PLAYER_SPEED = 260;

/** Create a player standing on the map's spawn point (or the first room). */
export function createPlayer(map: GameMap, color = "#38e1c8"): Player {
  const spawn = map.pointsOfInterest.find((p) => p.kind === "spawn");
  const fallback = map.rooms[0];
  const x = spawn?.x ?? fallback.x + fallback.w / 2;
  const y = spawn?.y ?? fallback.y + fallback.h / 2;

  return {
    x,
    y,
    radius: PLAYER_RADIUS,
    speed: PLAYER_SPEED,
    facingX: 0,
    facingY: -1,
    color,
  };
}

/** Advance the player by one tick. `input` is a (possibly unnormalized) vector. */
export function updatePlayer(
  map: GameMap,
  player: Player,
  input: MoveInput,
  dt: number,
): void {
  const mag = Math.hypot(input.x, input.y);
  if (mag === 0) return;

  const dx = input.x / mag;
  const dy = input.y / mag;
  player.facingX = dx;
  player.facingY = dy;

  const step = player.speed * dt;
  const next = moveWithCollision(
    map,
    { x: player.x, y: player.y },
    dx * step,
    dy * step,
    player.radius,
  );
  player.x = next.x;
  player.y = next.y;
}

export { canStand };
