import type { Vec2 } from "./collision";
import type { Crewmate } from "./crewmate";
import type { GameMap, PointOfInterest } from "./map";
import { findPath, followPath, type NavGrid } from "./navigation";

/**
 * Imposter behaviour is intentionally distinct from crewmates: they never run
 * tasks, they follow ("stalk") crewmates instead of patrolling POIs, and they
 * use the map's vent POIs to travel quickly.
 *
 * No perception, no kill/sabotage resolution yet — venting and stalking are
 * internal states only.
 */
export type ImposterState =
  | "idle"
  | "stalking"
  | "observing"
  | "seeking_vent"
  | "venting";

export interface Imposter {
  id: number;
  name: string;
  x: number;
  y: number;
  radius: number;
  speed: number;
  facingX: number;
  facingY: number;
  color: string;

  state: ImposterState;
  timer: number;
  path: Vec2[];
  pathIndex: number;
  stagnant: number;

  /** Stalking. */
  targetCrewmateId: number | null;
  lastCrewmateId: number | null;
  stalkTime: number;
  repathTimer: number;

  /** Venting. */
  targetPoiId: string | null;
  ventFromId: string | null;
  ventToId: string | null;
  lastVentId: string | null;
  ventCount: number;

  rngState: number;
}

export const IMPOSTER_RADIUS = 15;
export const IMPOSTER_SPEED = 230;
const IDLE_MIN = 0.3;
const IDLE_MAX = 0.9;
const STALK_DISTANCE = 95;
const STALK_REPATH = 0.7;
const STALK_GIVEUP = 22;
const OBSERVE_MIN = 1.5;
const OBSERVE_MAX = 3.0;
const VENT_TRAVEL = 1.2;
const STALK_PROB = 0.55;

export const IMPOSTER_COLORS = ["#b21e35", "#7c3aed"] as const;
export const IMPOSTER_NAMES = ["SHADE", "VEX"] as const;

function rand(imp: Imposter): number {
  imp.rngState = (imp.rngState + 0x6d2b79f5) | 0;
  let t = imp.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function ventPois(map: GameMap): PointOfInterest[] {
  return map.pointsOfInterest.filter((p) => p.kind === "vent");
}

/** Pick a random vent, preferring one other than the last used. */
function pickVent(map: GameMap, excludeId: string | null): PointOfInterest | null {
  const vents = ventPois(map);
  if (vents.length === 0) return null;
  const candidates = vents.filter((v) => v.id !== excludeId);
  const pool = candidates.length > 0 ? candidates : vents;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Nearest vent to the imposter (optionally excluding one). */
function nearestVent(
  map: GameMap,
  imp: Imposter,
  excludeId: string | null,
): PointOfInterest | null {
  const vents = ventPois(map).filter((v) => v.id !== excludeId);
  const pool = vents.length > 0 ? vents : ventPois(map);
  let best: PointOfInterest | null = null;
  let bestDist = Infinity;
  for (const v of pool) {
    const d = Math.hypot(v.x - imp.x, v.y - imp.y);
    if (d < bestDist) {
      bestDist = d;
      best = v;
    }
  }
  return best;
}

function pathTo(imp: Imposter, grid: NavGrid, to: Vec2): boolean {
  const path = findPath(grid, { x: imp.x, y: imp.y }, to);
  if (!path || path.length === 0) return false;
  imp.path = path;
  imp.pathIndex = 0;
  imp.stagnant = 0;
  return true;
}

export function createImposters(map: GameMap, count = 2, seed = 101): Imposter[] {
  const vents = ventPois(map);
  const spawn = map.pointsOfInterest.find((p) => p.kind === "spawn");
  const imposters: Imposter[] = [];

  for (let i = 0; i < count; i++) {
    const start = vents.length > 0 ? vents[i % vents.length] : null;
    const x = start?.x ?? spawn?.x ?? map.rooms[0].x + map.rooms[0].w / 2;
    const y = start?.y ?? spawn?.y ?? map.rooms[0].y + map.rooms[0].h / 2;

    imposters.push({
      id: i,
      name: IMPOSTER_NAMES[i % IMPOSTER_NAMES.length],
      x,
      y,
      radius: IMPOSTER_RADIUS,
      speed: IMPOSTER_SPEED,
      facingX: 0,
      facingY: 1,
      color: IMPOSTER_COLORS[i % IMPOSTER_COLORS.length],
      state: "idle",
      timer: 0.4 + i * 0.5,
      path: [],
      pathIndex: 0,
      stagnant: 0,
      targetCrewmateId: null,
      lastCrewmateId: null,
      stalkTime: 0,
      repathTimer: 0,
      targetPoiId: null,
      ventFromId: null,
      ventToId: null,
      lastVentId: start?.id ?? null,
      ventCount: 0,
      rngState: (seed + i * 7919) | 0 || 1,
    });
  }
  return imposters;
}

function goIdle(imp: Imposter): void {
  imp.state = "idle";
  imp.timer = IDLE_MIN + rand(imp) * (IDLE_MAX - IDLE_MIN);
  imp.targetCrewmateId = null;
  imp.targetPoiId = null;
  imp.path = [];
  imp.pathIndex = 0;
}

function startStalk(
  imp: Imposter,
  grid: NavGrid,
  crewmates: Crewmate[],
): boolean {
  if (crewmates.length === 0) return false;
  let target = crewmates[Math.floor(rand(imp) * crewmates.length)];
  for (let i = 0; i < 4 && target.id === imp.lastCrewmateId; i++) {
    target = crewmates[Math.floor(rand(imp) * crewmates.length)];
  }
  if (!pathTo(imp, grid, { x: target.x, y: target.y })) return false;

  imp.targetCrewmateId = target.id;
  imp.stalkTime = 0;
  imp.repathTimer = STALK_REPATH;
  imp.state = "stalking";
  return true;
}

function startVentTrip(imp: Imposter, map: GameMap, grid: NavGrid): boolean {
  const vent = nearestVent(map, imp, imp.lastVentId);
  if (!vent) return false;
  if (!pathTo(imp, grid, { x: vent.x, y: vent.y })) return false;

  imp.targetPoiId = vent.id;
  imp.state = "seeking_vent";
  return true;
}

function decide(imp: Imposter, map: GameMap, grid: NavGrid, crewmates: Crewmate[]): void {
  const wantsStalk = crewmates.length > 0 && rand(imp) < STALK_PROB;
  if (wantsStalk && startStalk(imp, grid, crewmates)) return;
  if (startVentTrip(imp, map, grid)) return;
  goIdle(imp);
}

function faceTo(imp: Imposter, x: number, y: number): void {
  const dx = x - imp.x;
  const dy = y - imp.y;
  const d = Math.hypot(dx, dy);
  if (d > 0.001) {
    imp.facingX = dx / d;
    imp.facingY = dy / d;
  }
}

function updateStalking(
  imp: Imposter,
  map: GameMap,
  grid: NavGrid,
  crewmates: Crewmate[],
  dt: number,
): void {
  const target = crewmates.find((c) => c.id === imp.targetCrewmateId);
  if (!target) {
    goIdle(imp);
    return;
  }

  imp.stalkTime += dt;
  imp.repathTimer -= dt;

  const dist = Math.hypot(target.x - imp.x, target.y - imp.y);
  if (dist <= STALK_DISTANCE) {
    imp.state = "observing";
    imp.timer = OBSERVE_MIN + rand(imp) * (OBSERVE_MAX - OBSERVE_MIN);
    faceTo(imp, target.x, target.y);
    return;
  }

  if (imp.stalkTime > STALK_GIVEUP) {
    imp.lastCrewmateId = imp.targetCrewmateId;
    goIdle(imp);
    return;
  }

  // Periodically re-path so we keep following a moving target.
  if (imp.repathTimer <= 0) {
    if (!pathTo(imp, grid, { x: target.x, y: target.y })) {
      goIdle(imp);
      return;
    }
    imp.repathTimer = STALK_REPATH;
  }

  const result = followPath(map, imp, dt);
  if (result === "arrived" || result === "blocked") {
    if (!pathTo(imp, grid, { x: target.x, y: target.y })) {
      goIdle(imp);
      return;
    }
    imp.repathTimer = STALK_REPATH;
  }
}

function updateObserving(
  imp: Imposter,
  grid: NavGrid,
  crewmates: Crewmate[],
  dt: number,
): void {
  imp.timer -= dt;
  const target = crewmates.find((c) => c.id === imp.targetCrewmateId);

  if (target) {
    faceTo(imp, target.x, target.y);
    const dist = Math.hypot(target.x - imp.x, target.y - imp.y);
    if (dist > STALK_DISTANCE * 1.7) {
      if (pathTo(imp, grid, { x: target.x, y: target.y })) {
        imp.state = "stalking";
        imp.repathTimer = STALK_REPATH;
        return;
      }
    }
  }

  if (imp.timer <= 0) {
    imp.lastCrewmateId = imp.targetCrewmateId;
    goIdle(imp);
  }
}

function updateSeekingVent(
  imp: Imposter,
  map: GameMap,
  grid: NavGrid,
  dt: number,
): void {
  const result = followPath(map, imp, dt);

  if (result === "arrived") {
    const to = pickVent(map, imp.targetPoiId);
    imp.ventFromId = imp.targetPoiId;
    imp.ventToId = to?.id ?? null;
    imp.lastVentId = imp.ventFromId;
    imp.state = "venting";
    imp.timer = VENT_TRAVEL;
    return;
  }

  if (result === "blocked") {
    const poi = map.pointsOfInterest.find((p) => p.id === imp.targetPoiId);
    if (!poi || !pathTo(imp, grid, { x: poi.x, y: poi.y })) goIdle(imp);
  }
}

function updateVenting(imp: Imposter, map: GameMap, dt: number): void {
  imp.timer -= dt;
  if (imp.timer > 0) return;

  const to = map.pointsOfInterest.find((p) => p.id === imp.ventToId);
  if (to) {
    // Emerging at another vent: this is the "fast travel" payoff.
    imp.x = to.x;
    imp.y = to.y;
  }
  imp.ventCount++;
  imp.ventFromId = null;
  imp.ventToId = null;
  goIdle(imp);
}

/** Advance one imposter by one tick. Crewmates are passed in as stalk targets. */
export function updateImposter(
  map: GameMap,
  grid: NavGrid,
  imp: Imposter,
  crewmates: Crewmate[],
  dt: number,
): void {
  switch (imp.state) {
    case "idle": {
      imp.timer -= dt;
      if (imp.timer <= 0) decide(imp, map, grid, crewmates);
      break;
    }
    case "stalking":
      updateStalking(imp, map, grid, crewmates, dt);
      break;
    case "observing":
      updateObserving(imp, grid, crewmates, dt);
      break;
    case "seeking_vent":
      updateSeekingVent(imp, map, grid, dt);
      break;
    case "venting":
      updateVenting(imp, map, dt);
      break;
  }
}
