/**
 * The Skeld deck map — data model.
 *
 * The layout is The Skeld from Among Us (Innersloth): 14 rooms plus the named
 * "Hallway" location, joined by the halls and doors of the real ship. Room and
 * corridor rectangles are measured off the official artwork — every box was
 * traced from the dark wall runs in `public/skeld-map.webp` (see
 * `scripts/gen-map-geom.ts`, which holds the art-pixel measurements and the
 * art->world scale): the engines and Reactor sit in the west wing joined by the
 * long vertical West Hall, MedBay/Security/Electrical hang off that spine,
 * Cafeteria dominates the north-centre, the bow carries
 * Weapons/Navigation/Shields with O2 and the east Hallway between Weapons and
 * Shields. Vent grates sit where they are on the real ship (14 grates in six
 * chains), and the sabotage consoles are the Reactor hand scanners and the
 * Electrical lights panel. See README.md for the provenance note.
 *
 * Coordinate system: top-left origin, +x right, +y down, units are "world
 * pixels". Rooms and corridors are axis-aligned rectangles so they can be used
 * directly for collision and for deriving a walkable grid.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RoomId =
  | "cafeteria"
  | "weapons"
  | "o2"
  | "navigation"
  | "shields"
  | "communications"
  | "storage"
  | "admin"
  | "electrical"
  | "security"
  | "reactor"
  | "upper_engine"
  | "lower_engine"
  | "medbay"
  | "hallway";

export interface Room extends Rect {
  id: RoomId;
  name: string;
  /** Short label drawn on the map. */
  short: string;
}

export interface Corridor extends Rect {
  id: string;
  /** Human/AI-facing name shown as `current_location` while standing in it. */
  name?: string;
  /**
   * Every room this corridor opens onto. The Skeld's corridors are hubs (the
   * west hall alone touches four rooms), so this is a list rather than a pair.
   */
  connects: RoomId[];
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
  id: "the_skeld",
  name: "The Skeld",
  width: 1920,
  height: 1200,

  // World pixels, converted from art-pixel measurements by gen-map-geom.ts.
  // Rooms sit a little inside their drawn walls so a 15px actor can never clip
  // a hull corner; corridors overlap the rooms they join by enough for the nav
  // grid's clearance circle to walk the seam.
  rooms: [
    { id: "upper_engine", name: "Upper Engine", short: "UPPER", x: 339, y: 129, w: 177, h: 253 },
    { id: "medbay", name: "MedBay", short: "MED", x: 662, y: 322, w: 196, h: 293 },
    { id: "cafeteria", name: "Cafeteria", short: "CAFE", x: 868, y: 25, w: 446, h: 485 },
    { id: "weapons", name: "Weapons", short: "WPN", x: 1409, y: 141, w: 157, h: 162 },
    { id: "reactor", name: "Reactor", short: "REACT", x: 21, y: 393, w: 317, h: 366 },
    { id: "security", name: "Security", short: "SEC", x: 470, y: 410, w: 189, h: 257 },
    { id: "o2", name: "O2", short: "O2", x: 1318, y: 505, w: 115, h: 41 },
    { id: "hallway", name: "Hallway", short: "HALL", x: 1440, y: 405, w: 119, h: 362 },
    { id: "navigation", name: "Navigation", short: "NAV", x: 1750, y: 417, w: 122, h: 179 },
    { id: "admin", name: "Admin", short: "ADMIN", x: 1165, y: 715, w: 238, h: 179 },
    { id: "electrical", name: "Electrical", short: "ELEC", x: 700, y: 620, w: 203, h: 282 },
    { id: "storage", name: "Storage", short: "STOR", x: 949, y: 679, w: 201, h: 418 },
    { id: "lower_engine", name: "Lower Engine", short: "LOWER", x: 337, y: 770, w: 179, h: 178 },
    { id: "communications", name: "Communications", short: "COMMS", x: 1173, y: 984, w: 201, h: 124 },
    { id: "shields", name: "Shields", short: "SHLD", x: 1410, y: 834, w: 105, h: 226 },
  ],

  corridors: [
    { id: "c_nw_hall", name: "Northwest Hall", connects: ["upper_engine", "medbay", "cafeteria"], x: 508, y: 210, w: 371, h: 122 },
    { id: "c_ne_hall", name: "Northeast Hall", connects: ["cafeteria", "weapons"], x: 1280, y: 226, w: 149, h: 83 },
    { id: "c_o2_door", name: "O2 Door", connects: ["cafeteria", "o2"], x: 1227, y: 477, w: 128, h: 71 },
    { id: "c_central_hall", name: "Central Hall", connects: ["cafeteria", "admin", "storage"], x: 1056, y: 453, w: 181, h: 340 },
    { id: "c_west_hall", name: "West Hall", connects: ["upper_engine", "reactor", "security", "lower_engine"], x: 331, y: 357, w: 173, h: 417 },
    { id: "c_sw_hall", name: "Southwest Hall", connects: ["lower_engine", "electrical", "storage"], x: 501, y: 834, w: 480, h: 71 },
    { id: "c_se_hall", name: "Southeast Hall", connects: ["admin", "storage", "communications", "shields"], x: 1067, y: 882, w: 469, h: 131 },
    { id: "c_door_weapons", name: "Weapons Door", connects: ["hallway", "weapons"], x: 1461, y: 238, w: 85, h: 191 },
    { id: "c_door_o2", name: "O2 Door", connects: ["hallway", "o2"], x: 1387, y: 477, w: 96, h: 95 },
    { id: "c_door_nav", name: "Navigation Door", connects: ["hallway", "navigation"], x: 1515, y: 500, w: 256, h: 83 },
    { id: "c_door_shields", name: "Shields Door", connects: ["hallway", "shields"], x: 1451, y: 715, w: 85, h: 238 },
  ],

  pointsOfInterest: [
    { id: "task_cafeteria", roomId: "cafeteria", kind: "task", x: 1067, y: 298, label: "Empty Garbage" },
    { id: "task_weapons", roomId: "weapons", kind: "task", x: 1483, y: 238, label: "Clear Asteroids" },
    { id: "task_medbay", roomId: "medbay", kind: "task", x: 757, y: 417, label: "Submit Scan" },
    { id: "task_upper_engine", roomId: "upper_engine", kind: "task", x: 427, y: 238, label: "Align Engine Output" },
    { id: "task_reactor", roomId: "reactor", kind: "task", x: 160, y: 572, label: "Start Reactor" },
    { id: "task_security", roomId: "security", kind: "task", x: 549, y: 536, label: "Fix Wiring" },
    { id: "task_admin", roomId: "admin", kind: "task", x: 1280, y: 834, label: "Swipe Card" },
    { id: "task_o2", roomId: "o2", kind: "task", x: 1376, y: 524, label: "Clean O2 Filter" },
    { id: "task_hallway", roomId: "hallway", kind: "task", x: 1493, y: 655, label: "Clean Vent" },
    { id: "task_navigation", roomId: "navigation", kind: "task", x: 1813, y: 500, label: "Chart Course" },
    { id: "task_lower_engine", roomId: "lower_engine", kind: "task", x: 427, y: 834, label: "Align Engine Output" },
    { id: "task_electrical", roomId: "electrical", kind: "task", x: 800, y: 739, label: "Calibrate Distributor" },
    { id: "task_storage", roomId: "storage", kind: "task", x: 1045, y: 870, label: "Fuel Engines" },
    { id: "task_communications", roomId: "communications", kind: "task", x: 1269, y: 1037, label: "Download Data" },
    { id: "task_shields", roomId: "shields", kind: "task", x: 1461, y: 906, label: "Prime Shields" },
    { id: "emergency", roomId: "cafeteria", kind: "emergency", x: 1077, y: 250, label: "Emergency button" },
    { id: "vent_cafeteria", roomId: "cafeteria", kind: "vent", x: 1259, y: 453, label: "Vent" },
    { id: "vent_admin", roomId: "admin", kind: "vent", x: 1216, y: 822, label: "Vent" },
    { id: "vent_hallway", roomId: "hallway", kind: "vent", x: 1515, y: 715, label: "Vent" },
    { id: "vent_weapons", roomId: "weapons", kind: "vent", x: 1536, y: 179, label: "Vent" },
    { id: "vent_navigation_n", roomId: "navigation", kind: "vent", x: 1781, y: 447, label: "Vent" },
    { id: "vent_navigation_s", roomId: "navigation", kind: "vent", x: 1781, y: 560, label: "Vent" },
    { id: "vent_shields", roomId: "shields", kind: "vent", x: 1472, y: 1013, label: "Vent" },
    { id: "vent_upper_engine", roomId: "upper_engine", kind: "vent", x: 363, y: 191, label: "Vent" },
    { id: "vent_reactor_n", roomId: "reactor", kind: "vent", x: 64, y: 453, label: "Vent" },
    { id: "vent_reactor_s", roomId: "reactor", kind: "vent", x: 64, y: 667, label: "Vent" },
    { id: "vent_lower_engine", roomId: "lower_engine", kind: "vent", x: 373, y: 858, label: "Vent" },
    { id: "vent_medbay", roomId: "medbay", kind: "vent", x: 704, y: 381, label: "Vent" },
    { id: "vent_security", roomId: "security", kind: "vent", x: 533, y: 477, label: "Vent" },
    { id: "vent_electrical", roomId: "electrical", kind: "vent", x: 747, y: 667, label: "Vent" },
    { id: "sab_hand_n", roomId: "reactor", kind: "sabotage", x: 43, y: 477, label: "Hand scanner (port)" },
    { id: "sab_hand_s", roomId: "reactor", kind: "sabotage", x: 43, y: 667, label: "Hand scanner (starboard)" },
    { id: "sab_lights", roomId: "electrical", kind: "sabotage", x: 725, y: 834, label: "Lights panel" },
    { id: "spawn_cafeteria", roomId: "cafeteria", kind: "spawn", x: 1077, y: 143, label: "Spawn" },
  ],
};

export function roomById(map: GameMap, id: RoomId): Room | undefined {
  return map.rooms.find((r) => r.id === id);
}

/**
 * Room containing a world point, falling back to the nearest room for points
 * that sit in a corridor. Used for perception notes and dialogue ("I saw them
 * in Storage"), so "nearest" is the useful answer, not `null`.
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
    for (const a of c.connects) {
      for (const b of c.connects) {
        if (a !== b) adj[a]?.push(b);
      }
    }
  }
  for (const id of Object.keys(adj) as RoomId[]) {
    adj[id] = [...new Set(adj[id])];
  }
  return adj;
}
