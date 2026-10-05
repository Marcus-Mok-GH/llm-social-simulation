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
    { id: "upper_engine", name: "Upper Engine", short: "UPPER", x: 40, y: 60, w: 300, h: 300 },
    { id: "medbay", name: "MedBay", short: "MED", x: 420, y: 60, w: 240, h: 240 },
    { id: "cafeteria", name: "Cafeteria", short: "CAFE", x: 720, y: 60, w: 440, h: 260 },
    { id: "weapons", name: "Weapons", short: "WPN", x: 1500, y: 60, w: 340, h: 240 },

    // West stack: Reactor, Security; centre: Admin; east: O2, Hallway, Nav.
    { id: "reactor", name: "Reactor", short: "REACT", x: 40, y: 400, w: 300, h: 320 },
    { id: "security", name: "Security", short: "SEC", x: 340, y: 400, w: 300, h: 260 },
    { id: "admin", name: "Admin", short: "ADMIN", x: 800, y: 420, w: 300, h: 240 },
    { id: "o2", name: "O2", short: "O2", x: 1240, y: 400, w: 220, h: 220 },
    { id: "hallway", name: "Hallway", short: "HALL", x: 1460, y: 340, w: 100, h: 400 },
    { id: "navigation", name: "Navigation", short: "NAV", x: 1560, y: 420, w: 320, h: 260 },

    // South row: Lower Engine, Electrical, Storage, Comms, Shields.
    { id: "lower_engine", name: "Lower Engine", short: "LOWER", x: 40, y: 840, w: 300, h: 300 },
    { id: "electrical", name: "Electrical", short: "ELEC", x: 420, y: 700, w: 280, h: 240 },
    { id: "storage", name: "Storage", short: "STOR", x: 740, y: 800, w: 440, h: 260 },
    { id: "communications", name: "Communications", short: "COMMS", x: 1220, y: 940, w: 260, h: 200 },
    { id: "shields", name: "Shields", short: "SHLD", x: 1560, y: 760, w: 320, h: 260 },
  ],

  corridors: [
    // The seven corridors of the real ship (each one is a hub, not a link).
    { id: "c_nw_hall", name: "Northwest Hall", connects: ["upper_engine", "medbay", "cafeteria"], x: 300, y: 250, w: 460, h: 70 },
    { id: "c_ne_hall", name: "Northeast Hall", connects: ["cafeteria", "weapons"], x: 1120, y: 120, w: 420, h: 70 },
    { id: "c_central_hall", name: "Central Hall", connects: ["cafeteria", "admin", "storage"], x: 760, y: 280, w: 80, h: 560 },
    { id: "c_west_hall", name: "West Hall", connects: ["upper_engine", "reactor", "security", "lower_engine"], x: 300, y: 320, w: 80, h: 580 },
    { id: "c_sw_hall", name: "Southwest Hall", connects: ["lower_engine", "electrical", "storage"], x: 280, y: 900, w: 500, h: 70 },
    { id: "c_se_hall", name: "Southeast Hall", connects: ["storage", "communications", "shields"], x: 1100, y: 980, w: 500, h: 70 },

    // The four doors off the east Hallway (Weapons, O2, Navigation, Shields).
    { id: "c_door_weapons", name: "Weapons Door", connects: ["hallway", "weapons"], x: 1480, y: 250, w: 80, h: 130 },
    { id: "c_door_o2", name: "O2 Door", connects: ["hallway", "o2"], x: 1420, y: 440, w: 80, h: 100 },
    { id: "c_door_nav", name: "Navigation Door", connects: ["hallway", "navigation"], x: 1520, y: 500, w: 100, h: 100 },
    { id: "c_door_shields", name: "Shields Door", connects: ["hallway", "shields"], x: 1480, y: 700, w: 120, h: 100 },
  ],

  pointsOfInterest: [
    // Task consoles — one per location, each a real Skeld task.
    { id: "task_cafeteria", roomId: "cafeteria", kind: "task", x: 1100, y: 120, label: "Empty Garbage" },
    { id: "task_weapons", roomId: "weapons", kind: "task", x: 1620, y: 160, label: "Clear Asteroids" },
    { id: "task_medbay", roomId: "medbay", kind: "task", x: 560, y: 170, label: "Submit Scan" },
    { id: "task_upper_engine", roomId: "upper_engine", kind: "task", x: 150, y: 220, label: "Align Engine Output" },
    { id: "task_reactor", roomId: "reactor", kind: "task", x: 150, y: 560, label: "Start Reactor" },
    { id: "task_security", roomId: "security", kind: "task", x: 560, y: 470, label: "Fix Wiring" },
    { id: "task_admin", roomId: "admin", kind: "task", x: 1040, y: 540, label: "Swipe Card" },
    { id: "task_o2", roomId: "o2", kind: "task", x: 1350, y: 510, label: "Clean O2 Filter" },
    { id: "task_hallway", roomId: "hallway", kind: "task", x: 1510, y: 380, label: "Clean Vent" },
    { id: "task_navigation", roomId: "navigation", kind: "task", x: 1740, y: 500, label: "Chart Course" },
    { id: "task_lower_engine", roomId: "lower_engine", kind: "task", x: 150, y: 960, label: "Align Engine Output" },
    { id: "task_electrical", roomId: "electrical", kind: "task", x: 640, y: 760, label: "Calibrate Distributor" },
    { id: "task_storage", roomId: "storage", kind: "task", x: 1000, y: 900, label: "Fuel Engines" },
    { id: "task_communications", roomId: "communications", kind: "task", x: 1400, y: 1030, label: "Download Data" },
    { id: "task_shields", roomId: "shields", kind: "task", x: 1660, y: 850, label: "Prime Shields" },

    // Emergency beacon (call a meeting) — Cafeteria, as on the real ship.
    { id: "emergency", roomId: "cafeteria", kind: "emergency", x: 900, y: 170, label: "Emergency button" },

    // Vents — 14 grates in the six chains of the real ship:
    //   Upper Engine ↔ Reactor(top) · Reactor(bottom) ↔ Lower Engine
    //   MedBay ↔ Security ↔ Electrical · Cafeteria ↔ Admin ↔ Hallway
    //   Weapons ↔ Navigation(top) · Navigation(bottom) ↔ Shields
    { id: "vent_cafeteria", roomId: "cafeteria", kind: "vent", x: 1130, y: 290, label: "Vent" },
    { id: "vent_admin", roomId: "admin", kind: "vent", x: 830, y: 630, label: "Vent" },
    { id: "vent_hallway", roomId: "hallway", kind: "vent", x: 1510, y: 700, label: "Vent" },
    { id: "vent_weapons", roomId: "weapons", kind: "vent", x: 1810, y: 90, label: "Vent" },
    { id: "vent_navigation_n", roomId: "navigation", kind: "vent", x: 1590, y: 450, label: "Vent" },
    { id: "vent_navigation_s", roomId: "navigation", kind: "vent", x: 1590, y: 650, label: "Vent" },
    { id: "vent_shields", roomId: "shields", kind: "vent", x: 1700, y: 990, label: "Vent" },
    { id: "vent_upper_engine", roomId: "upper_engine", kind: "vent", x: 315, y: 90, label: "Vent" },
    { id: "vent_reactor_n", roomId: "reactor", kind: "vent", x: 315, y: 430, label: "Vent" },
    { id: "vent_reactor_s", roomId: "reactor", kind: "vent", x: 315, y: 690, label: "Vent" },
    { id: "vent_lower_engine", roomId: "lower_engine", kind: "vent", x: 315, y: 1110, label: "Vent" },
    { id: "vent_medbay", roomId: "medbay", kind: "vent", x: 450, y: 270, label: "Vent" },
    { id: "vent_security", roomId: "security", kind: "vent", x: 610, y: 630, label: "Vent" },
    { id: "vent_electrical", roomId: "electrical", kind: "vent", x: 450, y: 730, label: "Vent" },

    // Sabotage targets — each is also a repair console during an outage.
    // Reactor Meltdown is fixed on the two hand scanners, Fix Lights in
    // Electrical (the O2 and Comms sabotages are not modelled by the engine).
    { id: "sab_hand_n", roomId: "reactor", kind: "sabotage", x: 90, y: 440, label: "Hand scanner (north)" },
    { id: "sab_hand_s", roomId: "reactor", kind: "sabotage", x: 90, y: 680, label: "Hand scanner (south)" },
    { id: "sab_lights", roomId: "electrical", kind: "sabotage", x: 470, y: 900, label: "Lights panel" },

    // Spawn / meeting point — Cafeteria.
    { id: "spawn_cafeteria", roomId: "cafeteria", kind: "spawn", x: 900, y: 250, label: "Spawn" },
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
