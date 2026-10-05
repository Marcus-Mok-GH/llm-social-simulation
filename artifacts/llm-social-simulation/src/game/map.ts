/**
 * The Skeld deck map — data model.
 *
 * The layout is The Skeld from Among Us (Innersloth): 14 rooms plus the named
 * "Hallway" location, joined by the seven corridors of the real ship. Room
 * rectangles are placed to match the official map's geography (engines and
 * Reactor to the west, Cafeteria north-centre, Weapons/Navigation/Shields on
 * the bow), vent grates sit where they are on the real ship (14 grates in six
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

  rooms: [
    // North row: engines, MedBay, Cafeteria, then Weapons on the port bow.
    { id: "upper_engine", name: "Upper Engine", short: "UPPER", x: 325, y: 66, w: 199, h: 292 },
    { id: "medbay", name: "MedBay", short: "MED", x: 644, y: 304, w: 203, h: 244 },
    { id: "cafeteria", name: "Cafeteria", short: "CAFE", x: 848, y: 24, w: 490, h: 393 },
    { id: "weapons", name: "Weapons", short: "WPN", x: 1342, y: 129, w: 199, h: 229 },

    // Middle band: Reactor and Security west, O2 / Hallway / Navigation east,
    // with Admin, Electrical and Storage amidships.
    { id: "reactor", name: "Reactor", short: "REACT", x: 160, y: 405, w: 235, h: 328 },
    { id: "security", name: "Security", short: "SEC", x: 443, y: 405, w: 201, h: 248 },
    { id: "o2", name: "O2", short: "O2", x: 1255, y: 423, w: 163, h: 167 },
    { id: "hallway", name: "Hallway", short: "HALL", x: 1427, y: 357, w: 100, h: 417 },
    { id: "navigation", name: "Navigation", short: "NAV", x: 1648, y: 381, w: 261, h: 250 },
    { id: "admin", name: "Admin", short: "ADMIN", x: 1109, y: 757, w: 293, h: 130 },
    { id: "electrical", name: "Electrical", short: "ELEC", x: 699, y: 620, w: 203, h: 214 },
    { id: "storage", name: "Storage", short: "STOR", x: 901, y: 763, w: 203, h: 310 },

    // South row: Lower Engine, Communications, then Shields on the bow.
    { id: "lower_engine", name: "Lower Engine", short: "LOWER", x: 325, y: 733, w: 197, h: 220 },
    { id: "communications", name: "Communications", short: "COMMS", x: 1109, y: 953, w: 240, h: 209 },
    { id: "shields", name: "Shields", short: "SHLD", x: 1360, y: 888, w: 229, h: 161 },
  ],

  corridors: [
    // Corridor rects are walkable collision padding the artwork's halls; each
    // one overlaps every room it joins by enough for the nav-grid clearance.
    // The six real-ship halls:
    { id: "c_nw_hall", name: "Northwest Hall", connects: ["upper_engine", "medbay", "cafeteria"], x: 485, y: 209, w: 480, h: 139 },
    { id: "c_ne_hall", name: "Northeast Hall", connects: ["cafeteria", "weapons"], x: 1227, y: 310, w: 213, h: 60 },
    { id: "c_central_hall", name: "Central Hall", connects: ["cafeteria", "admin", "storage"], x: 1013, y: 417, w: 181, h: 417 },
    { id: "c_west_hall", name: "West Hall", connects: ["upper_engine", "reactor", "security", "lower_engine"], x: 357, y: 312, w: 123, h: 468 },
    { id: "c_sw_hall", name: "Southwest Hall", connects: ["lower_engine", "electrical", "storage"], x: 480, y: 792, w: 469, h: 97 },
    { id: "c_se_hall", name: "Southeast Hall", connects: ["admin", "storage", "communications", "shields"], x: 1067, y: 852, w: 501, h: 137 },

    // The four doors off the east Hallway (Weapons, O2, Navigation, Shields).
    { id: "c_door_weapons", name: "Weapons Door", connects: ["hallway", "weapons"], x: 1442, y: 312, w: 64, h: 81 },
    { id: "c_door_o2", name: "O2 Door", connects: ["hallway", "o2"], x: 1381, y: 477, w: 80, h: 71 },
    { id: "c_door_nav", name: "Navigation Door", connects: ["hallway", "navigation"], x: 1488, y: 495, w: 197, h: 71 },
    { id: "c_door_shields", name: "Shields Door", connects: ["hallway", "shields"], x: 1467, y: 733, w: 61, h: 209 },
  ],

  pointsOfInterest: [
    // Task consoles — one per location, each a real Skeld task.
    { id: "task_cafeteria", roomId: "cafeteria", kind: "task", x: 928, y: 113, label: "Empty Garbage" },
    { id: "task_weapons", roomId: "weapons", kind: "task", x: 1435, y: 238, label: "Clear Asteroids" },
    { id: "task_medbay", roomId: "medbay", kind: "task", x: 688, y: 512, label: "Submit Scan" },
    { id: "task_upper_engine", roomId: "upper_engine", kind: "task", x: 427, y: 209, label: "Align Engine Output" },
    { id: "task_reactor", roomId: "reactor", kind: "task", x: 283, y: 554, label: "Start Reactor" },
    { id: "task_security", roomId: "security", kind: "task", x: 533, y: 560, label: "Fix Wiring" },
    { id: "task_admin", roomId: "admin", kind: "task", x: 1253, y: 816, label: "Swipe Card" },
    { id: "task_o2", roomId: "o2", kind: "task", x: 1333, y: 506, label: "Clean O2 Filter" },
    { id: "task_hallway", roomId: "hallway", kind: "task", x: 1476, y: 566, label: "Clean Vent" },
    { id: "task_navigation", roomId: "navigation", kind: "task", x: 1781, y: 512, label: "Chart Course" },
    { id: "task_lower_engine", roomId: "lower_engine", kind: "task", x: 427, y: 846, label: "Align Engine Output" },
    { id: "task_electrical", roomId: "electrical", kind: "task", x: 800, y: 727, label: "Calibrate Distributor" },
    { id: "task_storage", roomId: "storage", kind: "task", x: 1003, y: 918, label: "Fuel Engines" },
    { id: "task_communications", roomId: "communications", kind: "task", x: 1227, y: 1055, label: "Download Data" },
    { id: "task_shields", roomId: "shields", kind: "task", x: 1472, y: 965, label: "Prime Shields" },

    // Emergency beacon (call a meeting) — Cafeteria, as on the real ship.
    { id: "emergency", roomId: "cafeteria", kind: "emergency", x: 1088, y: 292, label: "Emergency button" },

    // Vents — 14 grates in the six chains of the real ship:
    //   Upper Engine ↔ Reactor(top) · Reactor(bottom) ↔ Lower Engine
    //   MedBay ↔ Security ↔ Electrical · Cafeteria ↔ Admin ↔ Hallway
    //   Weapons ↔ Navigation(top) · Navigation(bottom) ↔ Shields
    { id: "vent_cafeteria", roomId: "cafeteria", kind: "vent", x: 1312, y: 357, label: "Vent" },
    { id: "vent_admin", roomId: "admin", kind: "vent", x: 1147, y: 834, label: "Vent" },
    { id: "vent_hallway", roomId: "hallway", kind: "vent", x: 1476, y: 739, label: "Vent" },
    { id: "vent_weapons", roomId: "weapons", kind: "vent", x: 1515, y: 155, label: "Vent" },
    { id: "vent_navigation_n", roomId: "navigation", kind: "vent", x: 1675, y: 417, label: "Vent" },
    { id: "vent_navigation_s", roomId: "navigation", kind: "vent", x: 1675, y: 596, label: "Vent" },
    { id: "vent_shields", roomId: "shields", kind: "vent", x: 1547, y: 1019, label: "Vent" },
    { id: "vent_upper_engine", roomId: "upper_engine", kind: "vent", x: 352, y: 95, label: "Vent" },
    { id: "vent_reactor_n", roomId: "reactor", kind: "vent", x: 213, y: 441, label: "Vent" },
    { id: "vent_reactor_s", roomId: "reactor", kind: "vent", x: 213, y: 673, label: "Vent" },
    { id: "vent_lower_engine", roomId: "lower_engine", kind: "vent", x: 352, y: 924, label: "Vent" },
    { id: "vent_medbay", roomId: "medbay", kind: "vent", x: 661, y: 346, label: "Vent" },
    { id: "vent_security", roomId: "security", kind: "vent", x: 555, y: 477, label: "Vent" },
    { id: "vent_electrical", roomId: "electrical", kind: "vent", x: 731, y: 661, label: "Vent" },

    // Sabotage targets — each is also a repair console during an outage.
    // Reactor Meltdown is fixed on the two hand scanners, Fix Lights in
    // Electrical (the O2 and Comms sabotages are not modelled by the engine).
    { id: "sab_hand_n", roomId: "reactor", kind: "sabotage", x: 187, y: 477, label: "Hand scanner (north)" },
    { id: "sab_hand_s", roomId: "reactor", kind: "sabotage", x: 187, y: 661, label: "Hand scanner (south)" },
    { id: "sab_lights", roomId: "electrical", kind: "sabotage", x: 747, y: 804, label: "Lights panel" },

    // Spawn / meeting point — Cafeteria.
    { id: "spawn_cafeteria", roomId: "cafeteria", kind: "spawn", x: 1093, y: 143, label: "Spawn" },
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
