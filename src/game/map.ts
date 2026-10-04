/**
 * Station deck map — data model.
 *
 * Topology is inspired by the layout *concept* of a classic social-deduction
 * ship (a set of rooms joined by corridors, with a task/kill loop and a hidden
 * traitor). All names, coordinates, geometry and art here are original IP.
 *
 * Coordinate system: top-left origin, +x right, +y down, units are "world
 * pixels". Rooms and corridors are axis-aligned rectangles so they can later be
 * used directly for collision and for deriving a walkable grid.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RoomId =
  | "fore_thruster"
  | "armory"
  | "comms"
  | "mess_hall"
  | "infirmary"
  | "watchpost"
  | "command"
  | "nav"
  | "core_reactor"
  | "power_bay"
  | "hold"
  | "life_support";

export interface Room extends Rect {
  id: RoomId;
  name: string;
  /** Short label drawn on the map. */
  short: string;
}

export interface Corridor extends Rect {
  id: string;
  /** The two rooms this corridor links (for adjacency / pathing later). */
  connects: [RoomId, RoomId];
}

export type PoiKind =
  | "task"
  | "vent"
  | "emergency"
  | "sabotage"
  | "spawn";

export interface PointOfInterest {
  id: string;
  roomId: RoomId;
  kind: PoiKind;
  x: number;
  y: number;
  label: string;
}

export interface GameMap {
  id: string;
  name: string;
  width: number;
  height: number;
  rooms: Room[];
  corridors: Corridor[];
  pointsOfInterest: PointOfInterest[];
}

export const UMBRA_DECK_MAP: GameMap = {
  id: "umbra_deck",
  name: "Umbra Station — Deck K7",
  width: 1920,
  height: 1200,

  rooms: [
    { id: "fore_thruster", name: "Fore Thruster", short: "FORE", x: 240, y: 200, w: 220, h: 200 },
    { id: "armory", name: "Armory", short: "ARMY", x: 1180, y: 140, w: 220, h: 200 },
    { id: "comms", name: "Comms Array", short: "COMMS", x: 1520, y: 140, w: 200, h: 200 },
    { id: "mess_hall", name: "Mess Hall", short: "MESS", x: 660, y: 120, w: 360, h: 260 },
    { id: "infirmary", name: "Infirmary", short: "MED", x: 480, y: 520, w: 240, h: 200 },
    { id: "watchpost", name: "Watchpost", short: "WATCH", x: 900, y: 520, w: 200, h: 180 },
    { id: "command", name: "Command", short: "CMD", x: 1240, y: 460, w: 240, h: 220 },
    { id: "nav", name: "Nav Console", short: "NAV", x: 1520, y: 440, w: 180, h: 180 },
    { id: "core_reactor", name: "Core Reactor", short: "REACTOR", x: 240, y: 820, w: 240, h: 220 },
    { id: "power_bay", name: "Power Bay", short: "POWER", x: 620, y: 840, w: 260, h: 200 },
    { id: "hold", name: "Hold", short: "HOLD", x: 1000, y: 840, w: 300, h: 200 },
    { id: "life_support", name: "Life Support", short: "LIFE", x: 1420, y: 860, w: 220, h: 200 },
  ],

  corridors: [
    { id: "c_fore_mess", connects: ["fore_thruster", "mess_hall"], x: 460, y: 240, w: 200, h: 56 },
    { id: "c_fore_reactor", connects: ["fore_thruster", "core_reactor"], x: 300, y: 400, w: 56, h: 420 },
    { id: "c_reactor_power", connects: ["core_reactor", "power_bay"], x: 480, y: 920, w: 140, h: 56 },
    { id: "c_power_hold", connects: ["power_bay", "hold"], x: 880, y: 920, w: 120, h: 56 },
    { id: "c_mess_med", connects: ["mess_hall", "infirmary"], x: 664, y: 380, w: 56, h: 140 },
    { id: "c_med_power", connects: ["infirmary", "power_bay"], x: 664, y: 720, w: 56, h: 120 },
    { id: "c_mess_armory", connects: ["mess_hall", "armory"], x: 1020, y: 180, w: 160, h: 56 },
    { id: "c_mess_watch", connects: ["mess_hall", "watchpost"], x: 960, y: 380, w: 56, h: 140 },
    { id: "c_watch_cmd", connects: ["watchpost", "command"], x: 1100, y: 560, w: 140, h: 56 },
    { id: "c_watch_hold", connects: ["watchpost", "hold"], x: 1040, y: 700, w: 56, h: 140 },
    { id: "c_cmd_nav", connects: ["command", "nav"], x: 1480, y: 520, w: 40, h: 56 },
    { id: "c_cmd_life", connects: ["command", "life_support"], x: 1424, y: 680, w: 56, h: 180 },
    { id: "c_nav_life", connects: ["nav", "life_support"], x: 1560, y: 620, w: 56, h: 240 },
    { id: "c_armory_comms", connects: ["armory", "comms"], x: 1400, y: 210, w: 120, h: 56 },
    { id: "c_armory_cmd", connects: ["armory", "command"], x: 1300, y: 340, w: 56, h: 120 },
  ],

  pointsOfInterest: [
    // Tasks
    { id: "task_fore", roomId: "fore_thruster", kind: "task", x: 350, y: 300, label: "Prime thruster" },
    { id: "task_armory", roomId: "armory", kind: "task", x: 1290, y: 240, label: "Calibrate scope" },
    { id: "task_comms", roomId: "comms", kind: "task", x: 1620, y: 240, label: "Align array" },
    { id: "task_mess", roomId: "mess_hall", kind: "task", x: 760, y: 250, label: "Store rations" },
    { id: "task_med", roomId: "infirmary", kind: "task", x: 600, y: 620, label: "Scan vitals" },
    { id: "task_watch", roomId: "watchpost", kind: "task", x: 1000, y: 610, label: "Log patrol" },
    { id: "task_reactor", roomId: "core_reactor", kind: "task", x: 360, y: 930, label: "Stabilize core" },
    { id: "task_power", roomId: "power_bay", kind: "task", x: 750, y: 940, label: "Reset breaker" },
    { id: "task_hold", roomId: "hold", kind: "task", x: 1150, y: 940, label: "Sort cargo" },
    { id: "task_life", roomId: "life_support", kind: "task", x: 1530, y: 960, label: "Replace filter" },
    { id: "task_nav", roomId: "nav", kind: "task", x: 1610, y: 530, label: "Chart course" },
    { id: "task_cmd", roomId: "command", kind: "task", x: 1360, y: 570, label: "Review logs" },

    // Emergency beacon (call a meeting)
    { id: "emergency", roomId: "mess_hall", kind: "emergency", x: 840, y: 300, label: "Emergency beacon" },

    // Vents (imposter travel)
    { id: "vent_fore", roomId: "fore_thruster", kind: "vent", x: 430, y: 370, label: "Vent" },
    { id: "vent_armory", roomId: "armory", kind: "vent", x: 1370, y: 310, label: "Vent" },
    { id: "vent_mess", roomId: "mess_hall", kind: "vent", x: 990, y: 350, label: "Vent" },
    { id: "vent_med", roomId: "infirmary", kind: "vent", x: 690, y: 690, label: "Vent" },
    { id: "vent_cmd", roomId: "command", kind: "vent", x: 1450, y: 640, label: "Vent" },
    { id: "vent_nav", roomId: "nav", kind: "vent", x: 1670, y: 590, label: "Vent" },
    { id: "vent_reactor", roomId: "core_reactor", kind: "vent", x: 430, y: 1010, label: "Vent" },
    { id: "vent_power", roomId: "power_bay", kind: "vent", x: 700, y: 990, label: "Vent" },
    { id: "vent_hold", roomId: "hold", kind: "vent", x: 1250, y: 990, label: "Vent" },
    { id: "vent_life", roomId: "life_support", kind: "vent", x: 1600, y: 1010, label: "Vent" },

    // Sabotage targets — each is also a repair console during an outage.
    { id: "sab_reactor", roomId: "core_reactor", kind: "sabotage", x: 300, y: 1000, label: "Reactor meltdown" },
    { id: "sab_life", roomId: "life_support", kind: "sabotage", x: 1470, y: 1010, label: "Life support fault" },
    { id: "sab_power", roomId: "power_bay", kind: "sabotage", x: 660, y: 900, label: "Grid overload" },

    // Spawn / meeting point
    { id: "spawn_mess", roomId: "mess_hall", kind: "spawn", x: 840, y: 340, label: "Spawn" },
  ],
};

export function roomById(map: GameMap, id: RoomId): Room | undefined {
  return map.rooms.find((r) => r.id === id);
}

/**
 * Room containing a world point, falling back to the nearest room for points
 * that sit in a corridor. Used for perception notes and dialogue ("I saw them
 * in Comms"), so "nearest" is the useful answer, not `null`.
 */
export function roomAt(map: GameMap, x: number, y: number): Room {
  for (const r of map.rooms) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  let best = map.rooms[0];
  let bestD = Infinity;
  for (const r of map.rooms) {
    const cx = Math.max(r.x, Math.min(x, r.x + r.w));
    const cy = Math.max(r.y, Math.min(y, r.y + r.h));
    const d = Math.hypot(cx - x, cy - y);
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/** Nearest point of interest of a given kind, or null. */
export function nearestPoi(
  map: GameMap,
  kind: PoiKind,
  x: number,
  y: number,
): PointOfInterest | null {
  let best: PointOfInterest | null = null;
  let bestD = Infinity;
  for (const p of map.pointsOfInterest) {
    if (p.kind !== kind) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Adjacency list (room id -> connected room ids) derived from corridors. */
export function buildAdjacency(map: GameMap): Record<RoomId, RoomId[]> {
  const adj = {} as Record<RoomId, RoomId[]>;
  for (const room of map.rooms) adj[room.id] = [];
  for (const c of map.corridors) {
    const [a, b] = c.connects;
    adj[a]?.push(b);
    adj[b]?.push(a);
  }
  return adj;
}
