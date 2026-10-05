import type { Vec2 } from "./collision";
import type { Crewmate } from "./crewmate";
import type { GameMap, PointOfInterest } from "./map";
import { findPath, followPath, type NavGrid } from "./navigation";

/**
 * Imposter behaviour is intentionally distinct from crewmates: they never run
 * real tasks, they follow ("stalk") crewmates instead of patrolling POIs, and
 * they use the map's vent POIs to travel quickly. Kill resolution, sabotage and
 * perception live in `engine.ts` — this module only owns *movement*.
 */
export type ImposterState =
  | "idle"
  | "walking"
  | "stalking"
  | "observing"
  | "faking"
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

  /** Fake-tasking: standing still at a console pretending to work. */
  fakeProgress: number;

  rngState: number;
}

export const IMPOSTER_RADIUS = 15;
export const IMPOSTER_SPEED = 230;
const IDLE_MIN = 0.3;
const IDLE_MAX = 0.9;
/**
 * How close a stalker gets before it stops and watches. This must be inside
 * `KILL_RANGE` (44) in engine terms — hovering at arm's length means an
 * imposter can spend the whole match observing and never actually kill.
 */
const STALK_DISTANCE = 34;
const STALK_REPATH = 0.7;
const STALK_GIVEUP = 30;
const OBSERVE_MIN = 1.5;
const OBSERVE_MAX = 3.0;
const VENT_TRAVEL = 1.2;
const STALK_PROB = 0.55;
/** How long an imposter lingers at a console pretending to work. */
export const FAKE_DURATION = 4.5;

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
function pickVent(map: GameMap, imp: Imposter): PointOfInterest | null {
  const vents = ventPois(map);
  if (vents.length === 0) return null;
  const candidates = vents.filter((v) => v.id !== imp.targetPoiId);
  const pool = candidates.length > 0 ? candidates : vents;
  return pool[Math.floor(rand(imp) * pool.length)];
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
      fakeProgress: 0,
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
    const to = pickVent(map, imp);
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

function updateFaking(imp: Imposter, dt: number): void {
  imp.timer -= dt;
  imp.fakeProgress = Math.max(0, 1 - imp.timer / FAKE_DURATION);
  if (imp.timer > 0) return;
  imp.fakeProgress = 0;
  imp.targetPoiId = null;
  goIdle(imp);
}

function updateWalking(imp: Imposter, map: GameMap, grid: NavGrid, dt: number): void {
  const result = followPath(map, imp, dt);
  if (result === "arrived") {
    // Reached the ordered point: settle into an alibi or go back to planning.
    if (imp.targetPoiId) {
      imp.state = "faking";
      imp.timer = FAKE_DURATION;
      imp.fakeProgress = 0;
      return;
    }
    goIdle(imp);
    return;
  }
  if (result === "blocked") {
    const poi = map.pointsOfInterest.find((p) => p.id === imp.targetPoiId);
    if (!poi || !pathTo(imp, grid, { x: poi.x, y: poi.y })) goIdle(imp);
  }
}

// ---------------------------------------------------------------------------
// Decision-layer entry points — `engine.ts` picks the goal, these walk there.
// ---------------------------------------------------------------------------

/** Walk to a console and then pretend to work at it (the alibi). */
export function imposterFakeTask(
  imp: Imposter,
  map: GameMap,
  grid: NavGrid,
  poiId: string,
): boolean {
  const poi = map.pointsOfInterest.find((p) => p.id === poiId);
  if (!poi) return false;
  if (!pathTo(imp, grid, { x: poi.x, y: poi.y })) return false;
  imp.targetPoiId = poi.id;
  imp.state = "walking";
  return true;
}

/** Path to an arbitrary world point with no special action on arrival. */
export function imposterGotoPoint(imp: Imposter, grid: NavGrid, x: number, y: number): boolean {
  if (!pathTo(imp, grid, { x, y })) return false;
  imp.targetPoiId = null;
  imp.state = "walking";
  return true;
}

/** Chase a specific crewmate. */
export function imposterStalk(
  imp: Imposter,
  grid: NavGrid,
  crewmates: Crewmate[],
  targetId: number,
): boolean {
  const target = crewmates.find((c) => c.id === targetId);
  if (!target) return false;
  if (!pathTo(imp, grid, { x: target.x, y: target.y })) return false;
  imp.targetCrewmateId = target.id;
  imp.stalkTime = 0;
  imp.repathTimer = STALK_REPATH;
  imp.state = "stalking";
  return true;
}

/** Walk to a named vent, then take it. */
export function imposterSeekVent(
  imp: Imposter,
  map: GameMap,
  grid: NavGrid,
  poiId: string,
): boolean {
  const vent = map.pointsOfInterest.find((p) => p.id === poiId && p.kind === "vent");
  if (!vent) return false;
  if (!pathTo(imp, grid, { x: vent.x, y: vent.y })) return false;
  imp.targetPoiId = vent.id;
  imp.state = "seeking_vent";
  return true;
}

/** Freeze an imposter (meetings, briefing). */
export function imposterHalt(imp: Imposter): void {
  imp.state = "idle";
  imp.timer = 0.3;
  imp.path = [];
  imp.pathIndex = 0;
  imp.targetCrewmateId = null;
  imp.fakeProgress = 0;
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
    case "faking":
      updateFaking(imp, dt);
      break;
    case "walking":
      updateWalking(imp, map, grid, dt);
      break;
  }
}
