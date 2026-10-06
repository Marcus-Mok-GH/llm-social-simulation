import type { Vec2 } from "./collision";
import type { GameMap, PointOfInterest } from "./map";
import { findPath, followPath, type NavGrid } from "./navigation";

/**
 * Imposter behaviour is intentionally distinct from crewmates: they never run
 * real tasks, they fake work at consoles for an alibi, and they use the map's
 * vent POIs to travel quickly. Kill resolution, sabotage and perception live
 * in `engine.ts` — this module only owns *movement*.
 */
export type ImposterState = "idle" | "walking" | "faking" | "seeking_vent" | "venting";

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
  /** Consecutive blocked re-paths for the current destination, abandoned after 2. */
  blockRetries: number;

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
const VENT_TRAVEL = 1.2;
/** Chance an idle imposter repositions through the ducts instead of faking. */
const VENT_PROB = 0.3;
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
      blockRetries: 0,
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
  imp.targetPoiId = null;
  imp.path = [];
  imp.pathIndex = 0;
  imp.blockRetries = 0;
}

function startVentTrip(imp: Imposter, map: GameMap, grid: NavGrid): boolean {
  const vent = nearestVent(map, imp, imp.lastVentId);
  if (!vent) return false;
  if (!pathTo(imp, grid, { x: vent.x, y: vent.y })) return false;

  imp.targetPoiId = vent.id;
  imp.state = "seeking_vent";
  return true;
}

/** Pick a random console and walk to it to fake work (the alibi). */
function pickAlibiConsole(imp: Imposter, map: GameMap, grid: NavGrid): boolean {
  const consoles = map.pointsOfInterest.filter((p) => p.kind === "task");
  if (consoles.length === 0) return false;
  const poi = consoles[Math.floor(rand(imp) * consoles.length)];
  return imposterFakeTask(imp, map, grid, poi.id);
}

function decide(imp: Imposter, map: GameMap, grid: NavGrid, canVent: boolean): void {
  // Idle gaps look innocent: mostly fake work at a console, and only slip
  // through a vent when nobody is around to see it. No lock-on pursuit —
  // stalking is gone.
  if (rand(imp) > VENT_PROB && pickAlibiConsole(imp, map, grid)) return;
  if (canVent && startVentTrip(imp, map, grid)) return;
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

function updateSeekingVent(
  imp: Imposter,
  map: GameMap,
  grid: NavGrid,
  dt: number,
  canVent: boolean,
): void {
  const result = followPath(map, imp, dt);

  if (result === "arrived") {
    // The gate ran when the trip was planned, but the walk takes seconds and
    // the crew moves: if someone is watching the grate now, climbing in is a
    // confession. Abort and blend back into the crowd.
    if (!canVent) {
      goIdle(imp);
      return;
    }
    const to = pickVent(map, imp);
    imp.ventFromId = imp.targetPoiId;
    imp.ventToId = to?.id ?? null;
    imp.lastVentId = imp.ventFromId;
    imp.state = "venting";
    imp.timer = VENT_TRAVEL;
    return;
  }

  if (result === "blocked") {
    // A deterministic A* re-path to the same point reproduces the same wedge,
    // so retrying forever just freezes the agent. After a couple of blocked
    // attempts, abandon this destination and let idle re-planning pick a new
    // one.
    imp.blockRetries++;
    const poi = map.pointsOfInterest.find((p) => p.id === imp.targetPoiId);
    if (imp.blockRetries > 2 || !poi || !pathTo(imp, grid, { x: poi.x, y: poi.y })) goIdle(imp);
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
    imp.blockRetries++;
    const poi = map.pointsOfInterest.find((p) => p.id === imp.targetPoiId);
    if (imp.blockRetries > 2 || !poi || !pathTo(imp, grid, { x: poi.x, y: poi.y })) goIdle(imp);
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
  imp.blockRetries = 0;
  imp.state = "walking";
  return true;
}

/** Path to an arbitrary world point with no special action on arrival. */
export function imposterGotoPoint(imp: Imposter, grid: NavGrid, x: number, y: number): boolean {
  if (!pathTo(imp, grid, { x, y })) return false;
  imp.targetPoiId = null;
  imp.blockRetries = 0;
  imp.state = "walking";
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
  imp.blockRetries = 0;
  imp.state = "seeking_vent";
  return true;
}

/** Freeze an imposter (meetings, briefing). */
export function imposterHalt(imp: Imposter): void {
  imp.state = "idle";
  imp.timer = 0.3;
  imp.path = [];
  imp.pathIndex = 0;
  imp.fakeProgress = 0;
}

/**
 * Advance one imposter by one tick. `canVent` is the engine's read of "no crew
 * is in this imposter's sight" — venting under someone's eyes is a confession,
 * so idle vent trips only happen when the coast is clear.
 */
export function updateImposter(
  map: GameMap,
  grid: NavGrid,
  imp: Imposter,
  canVent: boolean,
  dt: number,
): void {
  switch (imp.state) {
    case "idle": {
      imp.timer -= dt;
      if (imp.timer <= 0) decide(imp, map, grid, canVent);
      break;
    }
    case "seeking_vent":
      updateSeekingVent(imp, map, grid, dt, canVent);
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
