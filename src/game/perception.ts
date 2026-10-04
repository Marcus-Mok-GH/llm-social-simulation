/**
 * Perception, memory and the belief model.
 *
 * Every agent owns a `Mind`: a capped ring of memory entries plus a suspicion
 * vector over the other actors. Nothing here knows about roles — the engine
 * decides *what* an agent observes (gated by line of sight) and this module
 * decides what that does to what they believe.
 *
 * Suspicion is the single number that later drives both meeting dialogue and
 * the vote, which is what makes the social layer consistent: an agent that says
 * "I saw SHADE by the vent" is saying it *because* SHADE is who it suspects,
 * not because a dialogue table picked a line at random.
 */

import type { RoomId } from "./map";

export type Role = "crew" | "imposter";

export type MemoryKind =
  | "sighted"
  | "kill"
  | "body"
  | "vent"
  | "sabotage"
  | "task"
  | "claim"
  | "report"
  | "eject";

export interface MemoryEntry {
  /** Simulation time in seconds. */
  t: number;
  kind: MemoryKind;
  /** Who the memory is about ("player", "crew:0", "imp:1"...). */
  actorKey: string;
  roomId: RoomId;
  /** Human-readable line, reused verbatim as a meeting statement. */
  text: string;
}

export interface SeenAt {
  t: number;
  roomId: RoomId;
  x: number;
  y: number;
}

export interface Mind {
  key: string;
  role: Role;
  /** Keys this agent will never seriously suspect (imposter allies). */
  allies: string[];
  /** targetKey -> 0..1. */
  suspicion: Record<string, number>;
  lastSeen: Record<string, SeenAt>;
  memories: MemoryEntry[];
  /** Body ids already taken into account (no double-counting). */
  bodiesSeen: Set<number>;
  /** Actor keys whose vent use has already been reported to this mind. */
  ventsSeen: Set<string>;
  /** Whether this agent has already reported / called an emergency. */
  hasReported: boolean;
  /** Vote cast during the current meeting. */
  vote: string | null;
}

const MEMORY_CAP = 40;
const BASELINE = 0.05;

export function createMind(key: string, role: Role, allies: string[] = []): Mind {
  return {
    key,
    role,
    allies,
    suspicion: {},
    lastSeen: {},
    memories: [],
    bodiesSeen: new Set(),
    ventsSeen: new Set(),
    hasReported: false,
    vote: null,
  };
}

export function remember(mind: Mind, entry: MemoryEntry): void {
  mind.memories.push(entry);
  if (mind.memories.length > MEMORY_CAP) mind.memories.shift();
}

/** Bounded add so a single event can never make suspicion saturate. */
export function bump(mind: Mind, target: string, delta: number): void {
  if (target === mind.key) return;
  if (mind.allies.includes(target)) return;
  const current = mind.suspicion[target] ?? BASELINE;
  mind.suspicion[target] = Math.max(0, Math.min(1, current + delta));
}

export function noteSighting(mind: Mind, target: string, roomId: RoomId, x: number, y: number, t: number): void {
  mind.lastSeen[target] = { t, roomId, x, y };
}

/** Suspicion relaxes back toward the baseline — old grudges fade. */
export function decay(mind: Mind, dt: number): void {
  const k = Math.exp(-dt / 45);
  for (const key of Object.keys(mind.suspicion)) {
    const v = mind.suspicion[key];
    mind.suspicion[key] = BASELINE + (v - BASELINE) * k;
  }
}

export interface Suspect {
  key: string;
  score: number;
}

/** Highest-suspicion target above a threshold, or null for "no strong lead". */
export function topSuspect(mind: Mind, threshold = 0.15): Suspect | null {
  let best: Suspect | null = null;
  for (const [key, score] of Object.entries(mind.suspicion)) {
    if (key === mind.key) continue;
    if (mind.allies.includes(key)) continue;
    if (!best || score > best.score) best = { key, score };
  }
  return best && best.score >= threshold ? best : null;
}

/**
 * Full ranking, used by the analyst overlay and by the LLM prompt builder.
 * `min` filters out the noise floor so callers only see meaningful leads.
 */
export function rankSuspects(mind: Mind, min = 0): Suspect[] {
  return Object.entries(mind.suspicion)
    .map(([key, score]) => ({ key, score }))
    .filter((s) => s.key !== mind.key && !mind.allies.includes(s.key) && s.score >= min)
    .sort((a, b) => b.score - a.score);
}
