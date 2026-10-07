/**
 * Task definitions and progress tracking.
 *
 * Classification follows the Among Us documentation for The Skeld: every console
 * on the deck is a **Short**, **Long** or **Common** task (see `TASK_LENGTH`).
 * A crewmate's list is built from those pools — `SHORT_TASKS_PER_CREW` quick
 * tasks (the docs' Short tasks plus the quick Common ones) and
 * `LONG_TASKS_PER_CREW` long tasks — so every crewmate, human or AI, is given
 * the same "5 short + 2 long" shape the real game uses.
 *
 * The crew task bar is shared: it fills from *every* completed task, AI or
 * human, and a full bar is an instant crew win. AI crewmates only get credit
 * for their own tasks each so one idle agent cannot stall the round.
 */

import { isLogConsole } from "./creative";
import type { GameMap, PointOfInterest, RoomId } from "./map";

export interface TaskAssignment {
  poiId: string;
  label: string;
  roomId: RoomId;
  roomName: string;
  /** Short/Long classification from the Among Us docs. */
  length: TaskLength;
  done: boolean;
}

export interface TaskBar {
  /** Tasks that count toward the win condition. */
  total: number;
  complete: number;
}

/**
 * How a console is classified in Among Us (The Skeld).
 *
 *   short  — a single stage, or two very short stages, done in seconds.
 *   long   — several stages, or one genuinely long stage (a scan wait, the
 *            reactor memory game, hauling fuel between rooms).
 *   common — every crewmate has it. Quick and single/multi-stage, so the deck
 *            runs it at short length for the 5-short quota.
 */
export type TaskLength = "short" | "long" | "common";

/**
 * The Skeld task lengths, keyed by the console label. Matches the Among Us
 * Wiki's task table and the standard task guides (Android Central, TheGamer,
 * Indie Game Culture): the deck's Short tasks are Align Engine Output,
 * Calibrate Distributor, Chart Course, Clean O2 Filter, Clean Vent and Prime
 * Shields; the Common tasks are Fix Wiring and Swipe Card; the Long tasks are
 * Clear Asteroids, Download Data, Empty Garbage, Fuel Engines, Start Reactor
 * and Submit Scan.
 */
export const TASK_LENGTH: Record<string, TaskLength> = {
  "Align Engine Output": "short", // Upper / Lower Engine
  "Calibrate Distributor": "short", // Electrical
  "Chart Course": "short", // Navigation
  "Clean O2 Filter": "short", // O2
  "Clean Vent": "short", // Hallway
  "Prime Shields": "short", // Shields
  "Fix Wiring": "common", // Security
  "Swipe Card": "common", // Admin
  "Clear Asteroids": "long", // Weapons
  "Download Data": "long", // Communications
  "Empty Garbage": "long", // Cafeteria
  "Fuel Engines": "long", // Storage
  "Start Reactor": "long", // Reactor
  "Submit Scan": "long", // MedBay
};

/** Task-length classification for a console label, defaulting to `short`. */
export function taskLength(label: string): TaskLength {
  return TASK_LENGTH[label] ?? "short";
}

/** How many quick tasks each crewmate is assigned (Among Us: short + common). */
export const SHORT_TASKS_PER_CREW = 5;
/** How many long tasks each crewmate is assigned. */
export const LONG_TASKS_PER_CREW = 2;
/** How many tasks count per AI crewmate. */
export const TASKS_PER_CREW = SHORT_TASKS_PER_CREW + LONG_TASKS_PER_CREW;
/** How many tasks the human is assigned. */
export const PLAYER_TASKS = TASKS_PER_CREW;

export function taskPois(map: GameMap) {
  return map.pointsOfInterest.filter((p) => p.kind === "task");
}

function toAssignment(map: GameMap, poi: PointOfInterest): TaskAssignment {
  const room = map.rooms.find((r) => r.id === poi.roomId);
  return {
    poiId: poi.id,
    label: poi.label,
    roomId: poi.roomId,
    roomName: room?.name ?? poi.roomId,
    length: taskLength(poi.label),
    done: false,
  };
}

/**
 * Deterministically hand one crewmate its list: `SHORT_TASKS_PER_CREW` quick
 * consoles and `LONG_TASKS_PER_CREW` long ones. `slot` rotates both pools so
 * different crewmates (and, via the caller's ordering, different matches) get
 * different lists — the pools are shared the way real Among Us task lists are.
 *
 * Both pools are ordered generative-console-first, so a slot's *first* task is
 * one of the written station-log consoles. That is what makes the log fill in
 * the opening minute of every match instead of racing the endgame (see
 * `creative.ts`).
 */
export function assignTasks(map: GameMap, slot = 0): TaskAssignment[] {
  const quick: PointOfInterest[] = [];
  const long: PointOfInterest[] = [];
  for (const poi of taskPois(map)) {
    (taskLength(poi.label) === "long" ? long : quick).push(poi);
  }
  // Written ("station log") consoles first, then plain timed ones; the sort is
  // stable, so each group keeps its map order.
  const byLogFirst = (a: PointOfInterest, b: PointOfInterest) =>
    Number(isLogConsole(b.id)) - Number(isLogConsole(a.id));
  quick.sort(byLogFirst);
  long.sort(byLogFirst);

  const pick = (pool: PointOfInterest[], count: number): TaskAssignment[] => {
    const out: TaskAssignment[] = [];
    for (let i = 0; i < count; i++) {
      out.push(toAssignment(map, pool[(slot + i) % pool.length]));
    }
    return out;
  };

  return [
    ...pick(quick, SHORT_TASKS_PER_CREW),
    ...pick(long, LONG_TASKS_PER_CREW),
  ];
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
