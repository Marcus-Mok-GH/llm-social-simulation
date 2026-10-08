/**
 * The wire between the browser and the autonomous match host.
 *
 * Transport is SSE (server → client) plus small POSTs (client → server), both
 * on the same origin the page is served from, so it survives the preview proxy
 * without any WebSocket upgrade handling. This module is pure: types plus the
 * fog-raster encoding, safe to import from either side.
 */

import type { ActorRow, Seat } from "../game/link";
import type { ActorStatus, Body, Snapshot } from "../game/engine";
import type { Player } from "../game/player";
import type { Crewmate } from "../game/crewmate";
import type { Imposter } from "../game/imposter";
import type { MatchRecord } from "../game/persistence";

/** Everything the canvas draws, as plain JSON. */
export interface RenderWire {
  /** The viewer-facing spectator flag (fog gate + camera). */
  spectator: boolean;
  revealRoles: boolean;
  player: Player;
  playerAlive: boolean;
  /** The player's participation status (`playerAlive` is derived from it). */
  playerStatus: ActorStatus;
  crew: Crewmate[];
  imp: Imposter[];
  bodies: Body[];
}

export interface StateMsg {
  type: "state";
  matchId: string;
  seq: number;
  snapshot: Snapshot;
  render: RenderWire;
  roster: ActorRow[];
  /**
   * The fog's "explored" raster as [start, len] runs of revealed cells.
   * Present only when it changed (and not more than a couple of times a
   * second); clients merge runs into their own grid.
   */
  explored?: number[];
}

export interface HelloMsg {
  type: "hello";
  session: string;
  seat: Seat;
  matchId: string;
  /** The first state, so a rejoining tab paints immediately. */
  state: StateMsg;
  history: MatchRecord[];
  note?: string;
}

export interface RecordMsg {
  type: "record";
  history: MatchRecord[];
}

export type ServerMsg = HelloMsg | StateMsg | RecordMsg;

export type ClientMsg =
  | { type: "key"; key: string; down: boolean }
  | { type: "touch"; x: number; y: number | null }
  | { type: "clear" }
  | { type: "begin"; spectate?: boolean }
  | { type: "interact" }
  | { type: "kill" }
  | { type: "report" }
  | { type: "sabotage" }
  | { type: "say"; text: string }
  | { type: "vote"; key: string | null }
  | { type: "advance" }
  | { type: "task"; done: boolean }
  | { type: "spectate" }
  | { type: "analyst"; on: boolean }
  | { type: "restart"; asImposter: boolean };

/** The POST body of `POST /__umbra/action`. */
export interface ActionEnvelope {
  session: string;
  msg: ClientMsg;
}

/**
 * Compress the explored raster (a `Uint8Array` of 0/1) into [start, len]
 * runs. Most of the deck is unrevealed for most of a match, so runs are few
 * and the JSON stays small.
 */
export function encodeExplored(bytes: Uint8Array): number[] {
  const runs: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    if (!bytes[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < bytes.length && bytes[i]) i++;
    runs.push(start, i - start);
  }
  return runs;
}

/** Merge encoded runs into a grid — an OR, never a reset. */
export function mergeExplored(into: Uint8Array, runs: number[]): void {
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const start = runs[i];
    const len = runs[i + 1];
    if (start < 0 || len <= 0) continue;
    const end = Math.min(into.length, start + len);
    for (let j = Math.max(0, start); j < end; j++) into[j] = 1;
  }
}
