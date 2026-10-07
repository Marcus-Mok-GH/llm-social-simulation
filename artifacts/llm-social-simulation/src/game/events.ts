/**
 * The match timeline.
 *
 * The engine already emits human-readable `system` lines into the chat log, and
 * every agent keeps its own append-only `Mind.memories`. This module is the
 * third, deliberately separate record: a small structured list of the beats
 * that make a round a *story* — a kill, a sabotage, a meeting, an ejection, the
 * verdict — with the facts (who, where, witnessed) kept as fields rather than
 * baked into prose.
 *
 * Nothing here affects play. It exists so the end-of-match recap can be built
 * from real structured data instead of parsing sentences back out of the
 * transcript, and so a finished match can be re-narrated later without
 * replaying the simulation. Events are append-only and never evicted.
 */

import type { Role } from "./perception";

export type SabotageKind = "meltdown" | "blackout";

export type MatchEvent =
  /** An imposter killed a crewmate. `witnessed` means someone saw the act. */
  | {
      kind: "kill";
      t: number;
      killerKey: string;
      killerName: string;
      victimKey: string;
      victimName: string;
      roomName: string;
      witnessed: boolean;
    }
  /** A sabotage began. */
  | { kind: "sabotage"; t: number; sabotage: SabotageKind }
  /** A sabotage was repaired (or the lights came back on their own). */
  | { kind: "repair"; t: number; sabotage: SabotageKind }
  /** A meeting was called by report or emergency beacon. */
  | {
      kind: "meeting";
      t: number;
      reason: "emergency" | "report";
      byKey: string;
      byName: string;
    }
  /** The crew voted someone out. */
  | {
      kind: "eject";
      t: number;
      key: string;
      name: string;
      role: Role;
      /** Names of everyone who voted for them. */
      voters: string[];
    }
  /** The match ended. */
  | { kind: "end"; t: number; winner: "crew" | "imposter"; reason: string };
