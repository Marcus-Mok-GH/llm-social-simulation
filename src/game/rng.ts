/**
 * Deterministic PRNG utilities.
 *
 * Every stochastic decision in the simulation (path choices, kill timing,
 * voting noise) draws from one of these so a headless match replayed with the
 * same seed produces the same result. That is what makes `scripts/simulate.ts`
 * able to assert on outcomes instead of just "it didn't crash".
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Pick a uniformly random element. */
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, good enough distribution for game logic. */
export function makeRng(seed = 1): Rng {
  let state = seed | 0 || 0x9e3779b9;

  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (n) => Math.floor(next() * Math.max(1, n)),
    chance: (p) => next() < p,
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}

/** Stable string hash, used to turn a transcript id into a seed. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
