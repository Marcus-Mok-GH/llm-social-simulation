/**
 * Task definitions and progress tracking.
 *
 * The crew task bar is shared: it fills from *every* completed task, AI or
 * human, and a full bar is an instant crew win. AI crewmates only get credit
 * for their first few tasks each so one idle agent cannot stall the round.
 */

import type { GameMap, RoomId } from "./map";

export interface TaskAssignment {
  poiId: string;
  label: string;
  roomId: RoomId;
  roomName: string;
  done: boolean;
}

export interface TaskBar {
  /** Tasks that count toward the win condition. */
  total: number;
  complete: number;
}

/** How many AI tasks count per crewmate. */
export const TASKS_PER_CREW = 4;
/** How many tasks the human is assigned. */
export const PLAYER_TASKS = 4;

export function taskPois(map: GameMap) {
  return map.pointsOfInterest.filter((p) => p.kind === "task");
}

/** Deterministically hand out `count` distinct task POIs. */
export function assignTasks(map: GameMap, count: number, offset = 0): TaskAssignment[] {
  const pois = taskPois(map);
  const out: TaskAssignment[] = [];
  for (let i = 0; i < count; i++) {
    const poi = pois[(i + offset) % pois.length];
    const room = map.rooms.find((r) => r.id === poi.roomId);
    out.push({
      poiId: poi.id,
      label: poi.label,
      roomId: poi.roomId,
      roomName: room?.name ?? poi.roomId,
      done: false,
    });
  }
  return out;
}

export function countDone(tasks: TaskAssignment[]): number {
  return tasks.reduce((n, t) => n + (t.done ? 1 : 0), 0);
}

export function taskBarFraction(bar: TaskBar): number {
  if (bar.total <= 0) return 1;
  return Math.min(1, bar.complete / bar.total);
}

export type MinigameKind = "wiring" | "calibration";

/**
 * Which minigame a console runs. Derived from the id rather than stored so the
 * map data stays the single source of truth and every replay picks the same
 * game for the same console.
 */
export function minigameKind(poiId: string): MinigameKind {
  let h = 0;
  for (let i = 0; i < poiId.length; i++) h = (h * 31 + poiId.charCodeAt(i)) | 0;
  return (h & 1) === 0 ? "wiring" : "calibration";
}
