/**
 * Development helper: converts room/corridor/POI boxes measured directly off
 * `public/skeld-map.webp` (1800x1007) into world coordinates (1920x1200).
 *
 * The artwork is stretched across the world rect by the renderer, so the
 * mapping is a plain per-axis scale. Run: bun scripts/gen-map-geom.ts
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

/** Measured from the artwork (art pixels, top-left origin). */
const ROOMS: [string, string, string, number, number, number, number][] = [
  ["upper_engine", "Upper Engine", "UPPER", 305, 55, 492, 300],
  ["medbay", "MedBay", "MED", 604, 255, 794, 460],
  ["cafeteria", "Cafeteria", "CAFE", 795, 20, 1254, 350],
  ["weapons", "Weapons", "WPN", 1258, 108, 1445, 300],
  ["reactor", "Reactor", "REACT", 150, 340, 370, 615],
  ["security", "Security", "SEC", 415, 340, 603, 548],
  ["o2", "O2", "O2", 1177, 355, 1330, 495],
  ["hallway", "Hallway", "HALL", 1338, 300, 1432, 650],
  ["navigation", "Navigation", "NAV", 1545, 320, 1790, 530],
  ["admin", "Admin", "ADMIN", 1040, 635, 1315, 744],
  ["electrical", "Electrical", "ELEC", 655, 520, 845, 700],
  ["storage", "Storage", "STOR", 845, 640, 1035, 900],
  ["lower_engine", "Lower Engine", "LOWER", 305, 615, 490, 800],
  ["communications", "Communications", "COMMS", 1040, 800, 1265, 975],
  ["shields", "Shields", "SHLD", 1275, 745, 1490, 880],
];

type Corridor = {
  id: string;
  name: string;
  connects: string[];
  box: [number, number, number, number];
};

// Corridor rectangles are invisible collision, not artwork: each one is drawn
// wide enough (>=35 art px of overlap with every room it joins) that the nav
// grid's 15px-clearance circle can actually walk through the seam.
const CORRIDORS: Corridor[] = [
  { id: "c_nw_hall", name: "Northwest Hall", connects: ["upper_engine", "medbay", "cafeteria"], box: [455, 175, 905, 292] },
  { id: "c_ne_hall", name: "Northeast Hall", connects: ["cafeteria", "weapons"], box: [1150, 260, 1350, 310] },
  { id: "c_central_hall", name: "Central Hall", connects: ["cafeteria", "admin", "storage"], box: [950, 350, 1120, 700] },
  { id: "c_west_hall", name: "West Hall", connects: ["upper_engine", "reactor", "security", "lower_engine"], box: [335, 262, 450, 655] },
  { id: "c_sw_hall", name: "Southwest Hall", connects: ["lower_engine", "electrical", "storage"], box: [450, 665, 890, 746] },
  { id: "c_se_hall", name: "Southeast Hall", connects: ["admin", "storage", "communications", "shields"], box: [1000, 715, 1470, 830] },
  { id: "c_door_weapons", name: "Weapons Door", connects: ["hallway", "weapons"], box: [1352, 262, 1412, 330] },
  { id: "c_door_o2", name: "O2 Door", connects: ["hallway", "o2"], box: [1295, 400, 1370, 460] },
  { id: "c_door_nav", name: "Navigation Door", connects: ["hallway", "navigation"], box: [1395, 415, 1580, 475] },
  { id: "c_door_shields", name: "Shields Door", connects: ["hallway", "shields"], box: [1375, 615, 1432, 790] },
];

type Poi = [string, string, "task" | "vent" | "emergency" | "sabotage" | "spawn", number, number, string];

const POIS: Poi[] = [
  ["task_cafeteria", "cafeteria", "task", 870, 95, "Empty Garbage"],
  ["task_weapons", "weapons", "task", 1345, 200, "Clear Asteroids"],
  ["task_medbay", "medbay", "task", 645, 430, "Submit Scan"],
  ["task_upper_engine", "upper_engine", "task", 400, 175, "Align Engine Output"],
  ["task_reactor", "reactor", "task", 265, 465, "Start Reactor"],
  ["task_security", "security", "task", 500, 470, "Fix Wiring"],
  ["task_admin", "admin", "task", 1175, 685, "Swipe Card"],
  ["task_o2", "o2", "task", 1250, 425, "Clean O2 Filter"],
  ["task_hallway", "hallway", "task", 1384, 475, "Clean Vent"],
  ["task_navigation", "navigation", "task", 1670, 430, "Chart Course"],
  ["task_lower_engine", "lower_engine", "task", 400, 710, "Align Engine Output"],
  ["task_electrical", "electrical", "task", 750, 610, "Calibrate Distributor"],
  ["task_storage", "storage", "task", 940, 770, "Fuel Engines"],
  ["task_communications", "communications", "task", 1150, 885, "Download Data"],
  ["task_shields", "shields", "task", 1380, 810, "Prime Shields"],

  ["emergency", "cafeteria", "emergency", 1020, 245, "Emergency button"],

  ["vent_cafeteria", "cafeteria", "vent", 1230, 300, "Vent"],
  ["vent_admin", "admin", "vent", 1075, 700, "Vent"],
  ["vent_hallway", "hallway", "vent", 1384, 620, "Vent"],
  ["vent_weapons", "weapons", "vent", 1420, 130, "Vent"],
  ["vent_navigation_n", "navigation", "vent", 1570, 350, "Vent"],
  ["vent_navigation_s", "navigation", "vent", 1570, 500, "Vent"],
  ["vent_shields", "shields", "vent", 1450, 855, "Vent"],
  ["vent_upper_engine", "upper_engine", "vent", 330, 80, "Vent"],
  ["vent_reactor_n", "reactor", "vent", 200, 370, "Vent"],
  ["vent_reactor_s", "reactor", "vent", 200, 565, "Vent"],
  ["vent_lower_engine", "lower_engine", "vent", 330, 775, "Vent"],
  ["vent_medbay", "medbay", "vent", 620, 290, "Vent"],
  ["vent_security", "security", "vent", 520, 400, "Vent"],
  ["vent_electrical", "electrical", "vent", 685, 555, "Vent"],

  ["sab_hand_n", "reactor", "sabotage", 175, 400, "Hand scanner (north)"],
  ["sab_hand_s", "reactor", "sabotage", 175, 555, "Hand scanner (south)"],
  ["sab_lights", "electrical", "sabotage", 700, 675, "Lights panel"],

  ["spawn_cafeteria", "cafeteria", "spawn", 1025, 120, "Spawn"],
];

const w = (x: number) => Math.round(x * SX);
const h = (y: number) => Math.round(y * SY);

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
