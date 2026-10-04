import type {
  Corridor,
  GameMap,
  PointOfInterest,
  Rect,
  Room,
} from "../map";
import type { Player } from "../player";
import type { Crewmate } from "../crewmate";
import type { Imposter } from "../imposter";
import type { VisibilityGrid } from "../vision";

export interface ViewTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

const COLORS = {
  space: "#05070d",
  grid: "rgba(56, 225, 200, 0.06)",
  corridorFill: "#141d2e",
  corridorStroke: "#26334a",
  roomFill: "#182135",
  roomStroke: "#32435f",
  label: "#cbd5e1",
  labelDim: "#64748b",
} as const;

const POI_COLORS: Record<PointOfInterest["kind"], string> = {
  task: "#ffb020",
  vent: "#38e1c8",
  emergency: "#ef4444",
  sabotage: "#f97316",
  spawn: "#94a3b8",
};

/** Fit the world into a canvas of the given CSS size (contain). */
export function computeTransform(
  map: GameMap,
  canvasW: number,
  canvasH: number,
): ViewTransform {
  const scale = Math.min(canvasW / map.width, canvasH / map.height);
  const offsetX = (canvasW - map.width * scale) / 2;
  const offsetY = (canvasH - map.height * scale) / 2;
  return { scale, offsetX, offsetY };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  radius: number,
): void {
  const { x, y, w, h } = r;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawCorridors(
  ctx: CanvasRenderingContext2D,
  corridors: Corridor[],
): void {
  for (const c of corridors) {
    ctx.fillStyle = COLORS.corridorFill;
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.strokeStyle = COLORS.corridorStroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
  }
}

function drawRooms(ctx: CanvasRenderingContext2D, rooms: Room[]): void {
  for (const r of rooms) {
    ctx.fillStyle = COLORS.roomFill;
    roundRect(ctx, r, 14);
    ctx.fill();
    ctx.strokeStyle = COLORS.roomStroke;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
}

function drawPoi(ctx: CanvasRenderingContext2D, poi: PointOfInterest): void {
  const { x, y, kind } = poi;
  ctx.fillStyle = POI_COLORS[kind];
  ctx.strokeStyle = POI_COLORS[kind];
  ctx.lineWidth = 3;

  switch (kind) {
    case "task": {
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.space;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "emergency": {
      ctx.beginPath();
      ctx.arc(x, y, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#fecaca";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "vent": {
      ctx.beginPath();
      ctx.moveTo(x, y + 12);
      ctx.lineTo(x - 12, y - 6);
      ctx.lineTo(x + 12, y - 6);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "sabotage": {
      ctx.beginPath();
      ctx.moveTo(x, y - 13);
      ctx.lineTo(x + 13, y);
      ctx.lineTo(x, y + 13);
      ctx.lineTo(x - 13, y);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "spawn": {
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      break;
    }
  }
}

function drawShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
): void {
  ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
  ctx.beginPath();
  ctx.ellipse(x, y + radius * 0.75, radius * 1.05, radius * 0.44, 0, 0, Math.PI * 2);
  ctx.fill();
}

interface Walker {
  x: number;
  y: number;
  radius: number;
  facingX: number;
  facingY: number;
  color: string;
}

/** Shared body/visor painting so crew and imposters look identical by default. */
function drawWalker(
  ctx: CanvasRenderingContext2D,
  w: Walker,
  opts: { visor?: string; outline?: string } = {},
): void {
  drawShadow(ctx, w.x, w.y, w.radius);

  ctx.fillStyle = w.color;
  ctx.beginPath();
  ctx.arc(w.x, w.y, w.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = opts.outline ?? "#0b1220";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.fillStyle = opts.visor ?? "#e2f5ff";
  ctx.beginPath();
  ctx.arc(
    w.x + w.facingX * w.radius * 0.32,
    w.y + w.facingY * w.radius * 0.32,
    w.radius * 0.3,
    0,
    Math.PI * 2,
  );
  ctx.fill();
}

function drawProgressRing(ctx: CanvasRenderingContext2D, w: Walker, p: number): void {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(w.x, w.y, w.radius + 6, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "#ffb020";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(
    w.x,
    w.y,
    w.radius + 6,
    -Math.PI / 2,
    -Math.PI / 2 + Math.PI * 2 * p,
  );
  ctx.stroke();
}

function drawPlayer(ctx: CanvasRenderingContext2D, p: Player, alive: boolean): void {
  ctx.save();
  if (!alive) ctx.globalAlpha = 0.4;
  drawWalker(ctx, p, { visor: alive ? "#e2f5ff" : "#94a3b8" });
  if (alive) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius + 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawCrewmate(ctx: CanvasRenderingContext2D, a: Crewmate): void {
  drawWalker(ctx, a);
  if (a.state === "working" && a.taskProgress > 0) drawProgressRing(ctx, a, a.taskProgress);
}

/**
 * Imposters are painted exactly like crewmates — no red marker, no red visor —
 * unless the analyst view is on. The tell has to come from what they *do*.
 */
function drawImposter(
  ctx: CanvasRenderingContext2D,
  a: Imposter,
  reveal: boolean,
): void {
  if (a.state === "venting") return; // inside the ducts

  drawWalker(ctx, a, reveal ? { visor: "#ff5a6e", outline: "#2b0710" } : {});
  if (a.state === "faking" && a.fakeProgress > 0) drawProgressRing(ctx, a, a.fakeProgress);

  if (reveal) {
    ctx.fillStyle = "#ff4d6a";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y - a.radius - 14);
    ctx.lineTo(a.x + 6, a.y - a.radius - 8);
    ctx.lineTo(a.x, a.y - a.radius - 2);
    ctx.lineTo(a.x - 6, a.y - a.radius - 8);
    ctx.closePath();
    ctx.fill();
  }
}

/** A corpse: collapsed figure with a torn visor. */
function drawBody(
  ctx: CanvasRenderingContext2D,
  b: { x: number; y: number; color: string },
): void {
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.beginPath();
  ctx.ellipse(b.x, b.y + 8, 24, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(-0.35);
  ctx.fillStyle = b.color;
  roundRect(ctx, { x: -22, y: -12, w: 44, h: 24 }, 11);
  ctx.fill();
  ctx.strokeStyle = "#0b1220";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = "#0b1220";
  ctx.beginPath();
  ctx.ellipse(10, -2, 7, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  ctx.arc(11, -2, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Dashed link from a stalking imposter to its prey — analyst view only. */
function drawStalkLink(
  ctx: CanvasRenderingContext2D,
  a: Imposter,
  target: Crewmate,
): void {
  ctx.save();
  ctx.setLineDash([5, 6]);
  ctx.strokeStyle = "rgba(255, 77, 106, 0.45)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(target.x, target.y);
  ctx.stroke();
  ctx.restore();
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  step: number,
): void {
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= map.width; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, map.height);
  }
  for (let y = 0; y <= map.height; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(map.width, y);
  }
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Fog of war
// ---------------------------------------------------------------------------

let exploredCanvas: HTMLCanvasElement | null = null;

/**
 * Rasterise the explored mask once per frame. Unknown cells are dark and
 * semi-opaque, revealed cells are fully transparent; drawn over the scene it
 * gives the "surveyed but not currently lit" look for free.
 */
function exploredLayer(grid: VisibilityGrid): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  if (!exploredCanvas) exploredCanvas = document.createElement("canvas");
  if (exploredCanvas.width !== grid.cols || exploredCanvas.height !== grid.rows) {
    exploredCanvas.width = grid.cols;
    exploredCanvas.height = grid.rows;
  }
  const ctx = exploredCanvas.getContext("2d");
  if (!ctx) return null;

  const img = ctx.createImageData(grid.cols, grid.rows);
  const data = img.data;
  for (let i = 0; i < grid.explored.length; i++) {
    const o = i * 4;
    if (grid.explored[i]) {
      data[o + 3] = 0;
    } else {
      data[o] = 2;
      data[o + 1] = 5;
      data[o + 2] = 12;
      data[o + 3] = 185;
    }
  }
  ctx.putImageData(img, 0, 0);
  return exploredCanvas;
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

export interface FogLayer {
  polygon: Float32Array;
  grid: VisibilityGrid;
}

export interface Scene {
  player?: Player | null;
  playerAlive?: boolean;
  crewmates?: Crewmate[];
  imposters?: Imposter[];
  bodies?: readonly { x: number; y: number; color: string }[];
  fog?: FogLayer | null;
  revealRoles?: boolean;
}

/**
 * Draw the whole map into a canvas whose backing store is `cssW*dpr` by
 * `cssH*dpr`. World shapes are drawn under a scaled transform; labels are drawn
 * in screen space so text stays a constant, readable size. Fog is applied last
 * so labels and actors are occluded with the world.
 */
export function drawMap(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  cssW: number,
  cssH: number,
  dpr: number,
  scene: Scene = {},
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.space;
  ctx.fillRect(0, 0, cssW, cssH);

  const t = computeTransform(map, cssW, cssH);
  const reveal = scene.revealRoles ?? false;

  ctx.setTransform(
    dpr * t.scale,
    0,
    0,
    dpr * t.scale,
    dpr * t.offsetX,
    dpr * t.offsetY,
  );
  drawGrid(ctx, map, 80);
  drawCorridors(ctx, map.corridors);
  drawRooms(ctx, map.rooms);
  for (const poi of map.pointsOfInterest) drawPoi(ctx, poi);

  if (reveal) {
    for (const a of scene.imposters ?? []) {
      if (a.state !== "stalking" && a.state !== "observing") continue;
      const target = scene.crewmates?.find((c) => c.id === a.targetCrewmateId);
      if (target) drawStalkLink(ctx, a, target);
    }
  }

  for (const b of scene.bodies ?? []) drawBody(ctx, b);
  for (const a of scene.crewmates ?? []) drawCrewmate(ctx, a);
  for (const a of scene.imposters ?? []) drawImposter(ctx, a, reveal);
  if (scene.player) drawPlayer(ctx, scene.player, scene.playerAlive ?? true);

  // Screen-space labels.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = (x: number) => x * t.scale + t.offsetX;
  const sy = (y: number) => y * t.scale + t.offsetY;

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const r of map.rooms) {
    const cx = sx(r.x + r.w / 2);
    const cy = sy(r.y + r.h / 2) - 6;
    ctx.fillStyle = COLORS.label;
    ctx.font = '700 13px "JetBrains Mono", monospace';
    ctx.fillText(r.name.toUpperCase(), cx, cy);
    ctx.fillStyle = COLORS.labelDim;
    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.fillText(`${r.w}×${r.h}`, cx, cy + 17);
  }

  if (scene.player) {
    ctx.fillStyle = "rgba(203, 213, 225, 0.9)";
    ctx.font = '700 10px "JetBrains Mono", monospace';
    ctx.fillText("YOU", sx(scene.player.x), sy(scene.player.y) + scene.player.radius + 13);
  }
  for (const a of scene.crewmates ?? []) {
    ctx.fillStyle = "rgba(203, 213, 225, 0.8)";
    ctx.font = '600 9px "JetBrains Mono", monospace';
    ctx.fillText(a.name, sx(a.x), sy(a.y) + a.radius + 12);
  }
  for (const a of scene.imposters ?? []) {
    ctx.fillStyle = reveal ? "rgba(255, 122, 146, 0.9)" : "rgba(203, 213, 225, 0.8)";
    ctx.font = '600 9px "JetBrains Mono", monospace';
    ctx.fillText(a.name, sx(a.x), sy(a.y) + a.radius + 12);
  }

  // --- fog ---------------------------------------------------------------
  const fog = scene.fog;
  if (fog) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Everything outside the ray-cast polygon goes dark.
    ctx.beginPath();
    ctx.rect(-400, -400, cssW + 800, cssH + 800);
    const poly = fog.polygon;
    if (poly.length >= 4) {
      ctx.moveTo(sx(poly[0]), sy(poly[1]));
      for (let i = 2; i < poly.length; i += 2) ctx.lineTo(sx(poly[i]), sy(poly[i + 1]));
      ctx.closePath();
    }
    ctx.fillStyle = "rgba(4, 7, 14, 0.95)";
    ctx.fill("evenodd");

    // 2. Never-visited space gets an extra layer of black.
    const layer = exploredLayer(fog.grid);
    if (layer) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(layer, sx(0), sy(0), map.width * t.scale, map.height * t.scale);
    }
  }
}

/** Legend entries for the UI. */
export const MAP_LEGEND: { kind: PointOfInterest["kind"]; label: string }[] = [
  { kind: "task", label: "Task console" },
  { kind: "emergency", label: "Emergency beacon" },
  { kind: "vent", label: "Vent" },
  { kind: "sabotage", label: "Sabotage / repair" },
  { kind: "spawn", label: "Meeting table" },
];

export const POI_LEGEND_COLORS = POI_COLORS;
