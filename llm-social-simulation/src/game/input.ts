export interface MoveInput {
  x: number;
  y: number;
}

const MOVEMENT_KEYS = new Set([
  "w",
  "a",
  "s",
  "d",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
]);

export function isMovementKey(key: string): boolean {
  return MOVEMENT_KEYS.has(key.toLowerCase());
}

/**
 * Convert the currently-held keys into a movement vector. Diagonals are
 * normalized so movement speed is equal in every direction.
 */
export function inputVectorFromKeys(keys: ReadonlySet<string>): MoveInput {
  let x = 0;
  let y = 0;

  if (keys.has("w") || keys.has("arrowup")) y -= 1;
  if (keys.has("s") || keys.has("arrowdown")) y += 1;
  if (keys.has("a") || keys.has("arrowleft")) x -= 1;
  if (keys.has("d") || keys.has("arrowright")) x += 1;

  const mag = Math.hypot(x, y);
  if (mag > 0) {
    x /= mag;
    y /= mag;
  }
  return { x, y };
}
