import { canStand, moveWithCollision, type Vec2 } from "./collision";
import type { GameMap } from "./map";
import { findPath, type NavGrid } from "./navigation";

export type CrewmateState = "idle" | "moving" | "working";

export interface Crewmate {
  id: number;
  name: string;
  x: number;
  y: number;
  radius: number;
  speed: number;
  facingX: number;
  facingY: number;
  color: string;

  state: CrewmateState;
  /** Countdown for the current state (idle pause / task duration). */
  timer: number;
  /** 0..1 while working. */
  taskProgress: number;
  completedTasks: number;

  targetPoiId: string | null;
  lastPoiId: string | null;

  path: Vec2[];
  pathIndex: number;

  /** Stuck detection. */
  stagnant: number;

  /** Per-agent PRNG state, so simulations are reproducible. */
  rngState: number;
}

export const CREWMATE_RADIUS = 15;
export const CREWMATE_SPEED = 190;
const IDLE_MIN = 0.7;
const IDLE_MAX = 1.9;
const WORK_DURATION = 3.2;
const ARRIVE_EPS = 9;
const STUCK_LIMIT = 1.2;

export const CREWMATE_COLORS = [
  "#e0463c",
  "#3b82f6",
  "#22c55e",
  "#eab308",
  "#f97316",
  "#a855f7",
] as const;

export const CREWMATE_NAMES = ["ROOK", "VEGA", "JUNO", "PIKE", "NOVA", "ASH"] as const;

/** Deterministic RNG (mulberry32). */
function rand(agent: Crewmate): number {
  agent.rngState = (agent.rngState + 0x6d2b79f5) | 0;
  let t = agent.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function taskPois(map: GameMap) {
  return map.pointsOfInterest.filter((p) => p.kind === "task");
}

/**
 * Create `count` crewmates, each starting on a distinct task POI so they begin
 * somewhere valid and immediately have somewhere to walk.
 */
export function createCrewmates(map: GameMap, count = 4, seed = 1): Crewmate[] {
  const pois = taskPois(map);
  const agents: Crewmate[] = [];

  for (let i = 0; i < count; i++) {
    const poi = pois[i % pois.length];
    const spawn = map.pointsOfInterest.find((p) => p.kind === "spawn");
    const start = canStand(map, poi.x, poi.y, CREWMATE_RADIUS)
      ? poi
      : (spawn ?? { x: map.rooms[0].x + map.rooms[0].w / 2, y: map.rooms[0].y + map.rooms[0].h / 2 });

    agents.push({
      id: i,
      name: CREWMATE_NAMES[i % CREWMATE_NAMES.length],
      x: start.x,
      y: start.y,
      radius: CREWMATE_RADIUS,
      speed: CREWMATE_SPEED,
      facingX: 0,
      facingY: 1,
      color: CREWMATE_COLORS[i % CREWMATE_COLORS.length],
      state: "idle",
      timer: 0.2 + i * 0.15,
      taskProgress: 0,
      completedTasks: 0,
      targetPoiId: null,
      lastPoiId: poi.id,
      path: [],
      pathIndex: 0,
      stagnant: 0,
      rngState: (seed + i * 9973) | 0 || 1,
    });
  }
  return agents;
}

/** Pick a task POI different from the one just visited and path to it. */
function chooseTarget(agent: Crewmate, map: GameMap, grid: NavGrid): boolean {
  const pois = taskPois(map);
  if (pois.length === 0) return false;

  let choice = pois[Math.floor(rand(agent) * pois.length)];
  for (let attempt = 0; attempt < 6 && (choice.id === agent.lastPoiId || choice.id === agent.targetPoiId); attempt++) {
    choice = pois[Math.floor(rand(agent) * pois.length)];
  }

  const path = findPath(grid, { x: agent.x, y: agent.y }, { x: choice.x, y: choice.y });
  if (!path || path.length === 0) return false;

  agent.targetPoiId = choice.id;
  agent.path = path;
  agent.pathIndex = 0;
  agent.stagnant = 0;
  agent.state = "moving";
  return true;
}

/**
 * Reaching a waypoint stops the agent but does *not* start work. Working a
 * console is an explicit, validated interaction (PLAN.md): the agent has to
 * choose it, and the engine checks it is close enough before any progress is
 * credited. The idle pause below gives the decision layer room to act.
 */
function settle(agent: Crewmate): void {
  agent.state = "idle";
  agent.timer = 2.5;
  agent.path = [];
  agent.pathIndex = 0;
  agent.taskProgress = 0;
}

/** Re-path to the current target, or give up and pick a new one. */
function recover(agent: Crewmate, map: GameMap, grid: NavGrid): void {
  const poi = map.pointsOfInterest.find((p) => p.id === agent.targetPoiId);
  if (poi) {
    const path = findPath(grid, { x: agent.x, y: agent.y }, { x: poi.x, y: poi.y });
    if (path && path.length > 0) {
      agent.path = path;
      agent.pathIndex = 0;
      agent.stagnant = 0;
      return;
    }
  }
  agent.state = "idle";
  agent.timer = 0.2;
  agent.targetPoiId = null;
  agent.path = [];
}

function moveAlongPath(agent: Crewmate, map: GameMap, grid: NavGrid, dt: number): void {
  if (agent.pathIndex >= agent.path.length) {
    settle(agent);
    return;
  }

  const target = agent.path[agent.pathIndex];
  const dx = target.x - agent.x;
  const dy = target.y - agent.y;
  const dist = Math.hypot(dx, dy);

  if (dist <= ARRIVE_EPS) {
    agent.pathIndex++;
    if (agent.pathIndex >= agent.path.length) settle(agent);
    return;
  }

  const ux = dx / dist;
  const uy = dy / dist;
  agent.facingX = ux;
  agent.facingY = uy;

  const step = agent.speed * dt;
  const before = { x: agent.x, y: agent.y };
  const next = moveWithCollision(map, before, ux * step, uy * step, agent.radius);
  agent.x = next.x;
  agent.y = next.y;

  const moved = Math.hypot(agent.x - before.x, agent.y - before.y);
  if (moved < step * 0.25) {
    agent.stagnant += dt;
    if (agent.stagnant > STUCK_LIMIT) recover(agent, map, grid);
  } else {
    agent.stagnant = 0;
  }
}

/**
 * Drive a crewmate to one specific console. Used by the decision layer, which
 * picks *which* console; the existing state machine still owns the walking.
 */
export function crewmateGotoPoi(
  agent: Crewmate,
  map: GameMap,
  grid: NavGrid,
  poiId: string,
): boolean {
  const poi = map.pointsOfInterest.find((p) => p.id === poiId);
  if (!poi) return false;
  const path = findPath(grid, { x: agent.x, y: agent.y }, { x: poi.x, y: poi.y });
  if (!path || path.length === 0) return false;

  agent.targetPoiId = poi.id;
  agent.path = path;
  agent.pathIndex = 0;
  agent.stagnant = 0;
  agent.state = "moving";
  agent.timer = 0;
  return true;
}

/** Walk to an arbitrary point (room centre, a body, the meeting table). */
export function crewmateGotoPoint(
  agent: Crewmate,
  grid: NavGrid,
  x: number,
  y: number,
  keepTarget = false,
): boolean {
  const path = findPath(grid, { x: agent.x, y: agent.y }, { x, y });
  if (!path || path.length === 0) return false;

  agent.path = path;
  agent.pathIndex = 0;
  agent.stagnant = 0;
  agent.state = "moving";
  agent.timer = 0;
  if (!keepTarget) agent.targetPoiId = null;
  return true;
}

/**
 * Begin working a specific console. Called by the engine only after it has
 * validated an `INTERACT`/`TASK` intent, so the state machine never starts work
 * on its own.
 */
export function crewmateWorkAt(
  agent: Crewmate,
  map: GameMap,
  poiId: string,
): boolean {
  const poi = map.pointsOfInterest.find((p) => p.id === poiId);
  if (!poi) return false;
  agent.targetPoiId = poi.id;
  agent.state = "working";
  agent.timer = WORK_DURATION;
  agent.taskProgress = 0;
  agent.path = [];
  agent.pathIndex = 0;
  return true;
}

/** Freeze a crewmate in place (meetings, briefing). */
export function crewmateHalt(agent: Crewmate): void {
  agent.state = "idle";
  agent.timer = 0.2;
  agent.path = [];
  agent.pathIndex = 0;
  agent.taskProgress = 0;
}

/** Advance one crewmate by one tick. */
export function updateCrewmate(
  map: GameMap,
  grid: NavGrid,
  agent: Crewmate,
  dt: number,
): void {
  switch (agent.state) {
    case "idle": {
      agent.timer -= dt;
      if (agent.timer <= 0) {
        if (!chooseTarget(agent, map, grid)) {
          agent.timer = 0.5;
        }
      }
      break;
    }
    case "moving": {
      moveAlongPath(agent, map, grid, dt);
      break;
    }
    case "working": {
      agent.timer -= dt;
      agent.taskProgress = Math.min(1, 1 - agent.timer / WORK_DURATION);
      if (agent.timer <= 0) {
        agent.completedTasks++;
        agent.lastPoiId = agent.targetPoiId;
        agent.targetPoiId = null;
        agent.taskProgress = 0;
        agent.state = "idle";
        agent.timer = IDLE_MIN + rand(agent) * (IDLE_MAX - IDLE_MIN);
      }
      break;
    }
  }
}
