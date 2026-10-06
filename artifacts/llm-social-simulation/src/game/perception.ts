/**
 * Perception, memory and the belief model.
 *
 * Every agent owns a `Mind`: a complete, append-only record of everything it
 * observed, said, decided and attended over the whole match, plus a suspicion
 * vector over the other actors. Nothing is ever evicted while the match runs,
 * so an agent can reason about the opening seconds as clearly as the last.
 * Nothing here knows about roles — the engine decides *what* an agent observes
 * (gated by line of sight) and this module decides what that does to what they
 * believe.
 *
 * Belief update rule: recording a memory is the only thing that moves
 * suspicion, via the per-kind weights in `KIND_WEIGHT`. The engine decides
 * *what* an agent observes (gated by line of sight) and this module decides
 * what that does to what they believe — the engine itself never touches the
 * suspicion scores, and no score is ever serialized into a model prompt.
 *
 * Suspicion still drives the offline dialogue and vote fallbacks, which is
 * what keeps the social layer consistent: an agent that says "I saw SHADE by
 * the vent" is saying it *because* SHADE is who it suspects, not because a
 * dialogue table picked a line at random.
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
  | "flag"
  | "report"
  | "eject"
  /** A public station-log entry: flavour to reason about, never evidence. */
  | "log";

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

/**
 * A meeting this agent personally attended, kept so it can reason about what
 * was said after the meeting ends. Without this the discussion is unknowable
 * to the decision layer the moment the meeting closes.
 */
export interface MeetingMemory {
  t: number;
  /** Why the meeting happened, e.g. "SHADE reported a body". */
  reason: string;
  /** Every line spoken, as "Name: text", oldest first. */
  lines: string[];
  /** Who was voted out, if anyone. */
  ejected: { key: string; name: string; role: Role } | null;
}

/** One decision the agent made, kept for the whole match. */
export interface DecisionEntry {
  t: number;
  /** The goal the agent committed to with this decision. */
  goal: string;
  /** One-line summary of what it did. */
  action: string;
  /** Why it chose it, in its own words (null on the heuristic fallback). */
  reasoning: string | null;
}

export interface Mind {
  key: string;
  role: Role;
  /** Keys this agent will never seriously suspect (imposter allies). */
  allies: string[];
  /** targetKey -> 0..1. */
  suspicion: Record<string, number>;
  lastSeen: Record<string, SeenAt>;
  /**
   * Every notable event this agent observed, oldest first. Append-only for the
   * whole match — nothing is ever evicted, so no early event is ever forgotten.
   */
  memories: MemoryEntry[];
  /** Body ids already taken into account (no double-counting). */
  bodiesSeen: Set<number>;
  /** Actor keys whose vent use has already been reported to this mind. */
  ventsSeen: Set<string>;
  /** Whether this agent has already reported / called an emergency. */
  hasReported: boolean;
  /** Vote cast during the current meeting. */
  vote: string | null;

  // --- persistent self-context, carried between decision ticks -----------
  /** The durable purpose this agent is pursuing right now, or null. */
  goal: string | null;
  /** Simulation time the current goal was adopted. */
  goalSince: number;
  /** Why the agent chose its most recent action, in its own words. */
  lastReasoning: string | null;
  /** One-line summary of the agent's most recent action. */
  lastAction: string | null;
  /** Human-readable name of the zone the agent last set out for. */
  lastMove: string | null;
  /** Every meeting this agent attended, oldest first (append-only). */
  meetings: MeetingMemory[];
  /** Every decision this agent made, oldest first (append-only). */
  journal: DecisionEntry[];
}

/**
 * How much each kind of first-hand observation moves the agent's suspicion of
 * the actor the memory is about. This table is the *only* place beliefs are
 * shaped: the engine records what an agent observed (`remember`), and the
 * belief follows from the agent's own memory log. No engine code path adjusts
 * suspicion directly, and no suspicion value is ever handed to the models —
 * they see the raw events in their history and reason from those.
 */
const KIND_WEIGHT: Record<MemoryKind, number> = {
  /** Watched them murder someone. */
  kill: 0.95,
  /** Watched them use a vent. */
  vent: 0.6,
  /** Incriminating circumstance (loitering by a body, last seen in the room). */
  flag: 0.35,
  /** Attribution of a triggered sabotage. */
  sabotage: 0.3,
  /** Neutral context: these memories inform reasoning, not suspicion. */
  sighted: 0,
  body: 0,
  task: 0,
  report: 0,
  eject: 0,
  log: 0,
};

/**
 * Hard ceiling on the opening bias a past match may inject. Deliberately below
 * `topSuspect`'s 0.15 floor, so a grudge colours who an agent watches and how it
 * breaks a tie without ever letting last shift's drama outvote this shift's
 * evidence.
 */
export const MAX_GRUDGE = 0.12;

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
    goal: null,
    goalSince: 0,
    lastReasoning: null,
    lastAction: null,
    lastMove: null,
    meetings: [],
    journal: [],
  };
}

/**
 * Record the agent's purpose and reasoning for this decision so the *next*
 * prompt can show the agent what it was doing and why, and append the decision
 * to its match-long journal. The `goalSince` clock is only reset when the goal
 * itself changes, so an agent can tell how long it has been committed to a plan.
 */
export function setGoal(
  mind: Mind,
  goal: string,
  t: number,
  reasoning?: string | null,
  action?: string | null,
): void {
  if (mind.goal !== goal) {
    mind.goal = goal;
    mind.goalSince = t;
  }
  if (reasoning) mind.lastReasoning = reasoning;
  if (action) mind.lastAction = action;
  mind.journal.push({
    t,
    goal,
    action: action ?? mind.lastAction ?? goal,
    reasoning: reasoning ?? null,
  });
}

export function clearGoal(mind: Mind): void {
  mind.goal = null;
  mind.goalSince = 0;
}

/** Bank a finished meeting for the whole match (append-only). */
export function rememberMeeting(mind: Mind, entry: MeetingMemory): void {
  mind.meetings.push(entry);
}

/**
 * Bank a notable observation for the whole match (append-only). Recording an
 * observation is also what moves the agent's belief about the actor it is
 * about: the weight comes from what was observed (the memory kind), never
 * from an engine override.
 */
export function remember(mind: Mind, entry: MemoryEntry): void {
  mind.memories.push(entry);
  const weight = KIND_WEIGHT[entry.kind];
  if (weight > 0) bump(mind, entry.actorKey, weight);
}

/**
 * Bounded add so a single event can never make suspicion saturate. Internal:
 * outside this module, beliefs change only through `remember`.
 */
function bump(mind: Mind, target: string, delta: number): void {
  if (target === mind.key) return;
  if (mind.allies.includes(target)) return;
  const current = mind.suspicion[target] ?? BASELINE;
  mind.suspicion[target] = Math.max(0, Math.min(1, current + delta));
}

/**
 * Open a match already distrusting someone, from a grudge carried over from a
 * previous shift (see `game/legacy.ts`). Capped at `MAX_GRUDGE` so cross-match
 * memory is a bias, never a verdict; `decay` thins it out as the round goes on.
 */
export function seedDistrust(mind: Mind, target: string, weight: number): boolean {
  if (target === mind.key || mind.allies.includes(target)) return false;
  const bias = Math.max(0, Math.min(MAX_GRUDGE, weight));
  if (bias <= 0) return false;
  const current = mind.suspicion[target] ?? BASELINE;
  const next = Math.max(current, Math.min(1, BASELINE + bias));
  if (next === current) return false;
  mind.suspicion[target] = next;
  return true;
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
 * Full ranking, used by the analyst overlay and by the offline dialogue and
 * vote fallbacks. `min` filters out the noise floor so callers only see
 * meaningful leads. Never serialized into a model prompt.
 */
export function rankSuspects(mind: Mind, min = 0): Suspect[] {
  return Object.entries(mind.suspicion)
    .map(([key, score]) => ({ key, score }))
    .filter((s) => s.key !== mind.key && !mind.allies.includes(s.key) && s.score >= min)
    .sort((a, b) => b.score - a.score);
}
