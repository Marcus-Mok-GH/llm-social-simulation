/**
 * Development helper: converts room/corridor/POI boxes measured directly off
 * `public/skeld-map.webp` (1800x1007) into world coordinates (1920x1200).
 *
 * The artwork is stretched across the world rect by the renderer, so the
 * mapping is a plain per-axis scale. Run: bun scripts/gen-map-geom.ts
 *
 * Every box below was measured off the artwork's wall lines: the dark hull and
 * wall runs (`luminance < 55`) that bound each room, the corridor floor tint
 * that separates the halls, and the door gaps punched through those walls. Boxes
 * are deliberately a little *inside* the drawn floor so a 15px actor can never
 * clip a corner of hull.
 */
const ART_W = 1800;
const ART_H = 1007;
const WORLD_W = 1920;
const WORLD_H = 1200;

const SX = WORLD_W / ART_W;
const SY = WORLD_H / ART_H;

const box = (x0: number, y0: number, x1: number, y1: number) => ({
  x: Math.round(x0 * SX),
  y: Math.round(y0 * SY),
  w: Math.round((x1 - x0) * SX),
  h: Math.round((y1 - y0) * SY),
});

const w = (x: number) => Math.round(x * SX);
const h = (y: number) => Math.round(y * SY);

/** Measured from the artwork (art pixels, top-left origin). */
const ROOMS: [string, string, string, number, number, number, number][] = [
  // North row: Upper Engine under the port hull, then Cafeteria amidships and
  // Weapons on the starboard bow.
  ["upper_engine", "Upper Engine", "UPPER", 318, 108, 484, 320],
  ["medbay", "MedBay", "MED", 621, 270, 805, 516],
  ["cafeteria", "Cafeteria", "CAFE", 814, 21, 1232, 428],
  ["weapons", "Weapons", "WPN", 1321, 118, 1468, 254],

  // Middle band: Reactor on the port nose, Security and MedBay inboard of it,
  // O2 / Hallway / Navigation on the starboard side, Admin / Electrical /
  // Storage amidships.
  ["reactor", "Reactor", "REACT", 20, 330, 317, 637],
  ["security", "Security", "SEC", 441, 344, 618, 560],
  ["o2", "O2", "O2", 1236, 424, 1344, 458],
  ["hallway", "Hallway", "HALL", 1350, 340, 1462, 644],
  ["navigation", "Navigation", "NAV", 1641, 350, 1755, 500],
  ["admin", "Admin", "ADMIN", 1092, 600, 1315, 750],
  ["electrical", "Electrical", "ELEC", 656, 520, 846, 757],
  ["storage", "Storage", "STOR", 890, 570, 1078, 921],

  // South row: Lower Engine, Communications, then Shields on the starboard bow.
  ["lower_engine", "Lower Engine", "LOWER", 316, 646, 484, 795],
  ["communications", "Communications", "COMMS", 1100, 826, 1288, 930],
  ["shields", "Shields", "SHLD", 1322, 700, 1420, 890],
];

type Corridor = {
  id: string;
  name: string;
  connects: string[];
  box: [number, number, number, number];
};

// Corridor rectangles are invisible collision, not artwork: each one is drawn
// wide enough (>=20 art px of overlap with every room it joins) that the nav
// grid's 15px-clearance circle can actually walk through the seam.
const CORRIDORS: Corridor[] = [
  { id: "c_nw_hall", name: "Northwest Hall", connects: ["upper_engine", "medbay", "cafeteria"], box: [476, 176, 824, 278] },
  { id: "c_ne_hall", name: "Northeast Hall", connects: ["cafeteria", "weapons"], box: [1200, 190, 1340, 260] },
  { id: "c_o2_door", name: "O2 Door", connects: ["cafeteria", "o2"], box: [1150, 400, 1270, 460] },
  { id: "c_central_hall", name: "Central Hall", connects: ["cafeteria", "admin", "storage"], box: [990, 380, 1160, 665] },
  { id: "c_west_hall", name: "West Hall", connects: ["upper_engine", "reactor", "security", "lower_engine"], box: [310, 300, 472, 650] },
  { id: "c_sw_hall", name: "Southwest Hall", connects: ["lower_engine", "electrical", "storage"], box: [470, 700, 920, 760] },
  { id: "c_se_hall", name: "Southeast Hall", connects: ["admin", "storage", "communications", "shields"], box: [1000, 740, 1440, 850] },

  // The four doors off the east Hallway (Weapons, O2 side, Navigation, Shields).
  { id: "c_door_weapons", name: "Weapons Door", connects: ["hallway", "weapons"], box: [1370, 200, 1450, 360] },
  { id: "c_door_o2", name: "O2 Door", connects: ["hallway", "o2"], box: [1300, 400, 1390, 480] },
  { id: "c_door_nav", name: "Navigation Door", connects: ["hallway", "navigation"], box: [1420, 420, 1660, 490] },
  { id: "c_door_shields", name: "Shields Door", connects: ["hallway", "shields"], box: [1360, 600, 1440, 800] },
];

type Poi = [string, string, "task" | "vent" | "emergency" | "sabotage" | "spawn", number, number, string];

const POIS: Poi[] = [
  ["task_cafeteria", "cafeteria", "task", 1000, 250, "Empty Garbage"],
  ["task_weapons", "weapons", "task", 1390, 200, "Clear Asteroids"],
  ["task_medbay", "medbay", "task", 710, 350, "Submit Scan"],
  ["task_upper_engine", "upper_engine", "task", 400, 200, "Align Engine Output"],
  ["task_reactor", "reactor", "task", 150, 480, "Start Reactor"],
  ["task_security", "security", "task", 515, 450, "Fix Wiring"],
  ["task_admin", "admin", "task", 1200, 700, "Swipe Card"],
  ["task_o2", "o2", "task", 1290, 440, "Clean O2 Filter"],
  ["task_hallway", "hallway", "task", 1400, 550, "Clean Vent"],
  ["task_navigation", "navigation", "task", 1700, 420, "Chart Course"],
  ["task_lower_engine", "lower_engine", "task", 400, 700, "Align Engine Output"],
  ["task_electrical", "electrical", "task", 750, 620, "Calibrate Distributor"],
  ["task_storage", "storage", "task", 980, 730, "Fuel Engines"],
  ["task_communications", "communications", "task", 1190, 870, "Download Data"],
  ["task_shields", "shields", "task", 1370, 760, "Prime Shields"],

  ["emergency", "cafeteria", "emergency", 1010, 210, "Emergency button"],

  // Vents — the 14 grates of the real ship, in its six chains:
  //   Upper Engine ↔ Reactor(port) · Reactor(starboard) ↔ Lower Engine
  //   MedBay ↔ Security ↔ Electrical · Cafeteria ↔ Admin ↔ Hallway
  //   Weapons ↔ Navigation(upper) · Navigation(lower) ↔ Shields
  ["vent_cafeteria", "cafeteria", "vent", 1180, 380, "Vent"],
  ["vent_admin", "admin", "vent", 1140, 690, "Vent"],
  ["vent_hallway", "hallway", "vent", 1420, 600, "Vent"],
  ["vent_weapons", "weapons", "vent", 1440, 150, "Vent"],
  ["vent_navigation_n", "navigation", "vent", 1670, 375, "Vent"],
  ["vent_navigation_s", "navigation", "vent", 1670, 470, "Vent"],
  ["vent_shields", "shields", "vent", 1380, 850, "Vent"],
  ["vent_upper_engine", "upper_engine", "vent", 340, 160, "Vent"],
  ["vent_reactor_n", "reactor", "vent", 60, 380, "Vent"],
  ["vent_reactor_s", "reactor", "vent", 60, 560, "Vent"],
  ["vent_lower_engine", "lower_engine", "vent", 350, 720, "Vent"],
  ["vent_medbay", "medbay", "vent", 660, 320, "Vent"],
  ["vent_security", "security", "vent", 500, 400, "Vent"],
  ["vent_electrical", "electrical", "vent", 700, 560, "Vent"],

  // Sabotage targets — each is also a repair console during an outage.
  // Reactor Meltdown is fixed on the two hand scanners, Fix Lights in
  // Electrical (the O2 and Comms sabotages are not modelled by the engine).
  ["sab_hand_n", "reactor", "sabotage", 40, 400, "Hand scanner (port)"],
  ["sab_hand_s", "reactor", "sabotage", 40, 560, "Hand scanner (starboard)"],
  ["sab_lights", "electrical", "sabotage", 680, 700, "Lights panel"],

  ["spawn_cafeteria", "cafeteria", "spawn", 1010, 120, "Spawn"],
];

const out: string[] = [];
out.push(`  rooms: [`);
for (const [id, name, short, x0, y0, x1, y1] of ROOMS) {
  const b = box(x0, y0, x1, y1);
  out.push(`    { id: "${id}", name: "${name}", short: "${short}", x: ${b.x}, y: ${b.y}, w: ${b.w}, h: ${b.h} },`);
}
out.push(`  ],\n`);
out.push(`  corridors: [`);
for (const c of CORRIDORS) {
  const b = box(...c.box);
  out.push(
    `    { id: "${c.id}", name: "${c.name}", connects: [${c.connects.map((s) => `"${s}"`).join(", ")}], x: ${b.x}, y: ${b.y}, w: ${b.w}, h: ${b.h} },`,
  );
}
out.push(`  ],\n`);
out.push(`  pointsOfInterest: [`);
for (const [id, roomId, kind, ax, ay, label] of POIS) {
  out.push(`    { id: "${id}", roomId: "${roomId}", kind: "${kind}", x: ${w(ax)}, y: ${h(ay)}, label: "${label}" },`);
}
out.push(`  ],`);

process.stdout.write(out.join("\n") + "\n");

// Sanity: every POI must sit inside its room (validator requirement).
const roomBox = new Map(ROOMS.map(([id, , , x0, y0, x1, y1]) => [id, box(x0, y0, x1, y1)]));
let bad = 0;
for (const [id, roomId, , ax, ay] of POIS) {
  const r = roomBox.get(roomId)!;
  const px = w(ax);
  const py = h(ay);
  if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) {
    console.error(`  ✗ POI ${id} (${roomId}) at world ${px},${py} outside room ${JSON.stringify(r)}`);
    bad++;
  }
}
console.error(bad ? `${bad} POI(s) outside their room` : "all POIs inside their room ✓");
