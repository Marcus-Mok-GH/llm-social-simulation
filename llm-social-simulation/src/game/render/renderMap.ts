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

function drawPlayer(ctx: CanvasRenderingContext2D, p: Player): void {
  // Soft shadow so the player reads as standing on the floor.
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.beginPath();
  ctx.ellipse(p.x, p.y + p.radius * 0.75, p.radius * 1.05, p.radius * 0.45, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body.
  ctx.fillStyle = p.color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#0b1220";
  ctx.lineWidth = 3;
  ctx.stroke();

  // Visor, offset in the facing direction.
  ctx.fillStyle = "#e2f5ff";
  ctx.beginPath();
  ctx.arc(
    p.x + p.facingX * p.radius * 0.34,
    p.y + p.facingY * p.radius * 0.34,
    p.radius * 0.34,
    0,
    Math.PI * 2,
  );
  ctx.fill();

  // Facing ring.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.radius + 4, 0, Math.PI * 2);
  ctx.stroke();
}

function drawCrewmate(ctx: CanvasRenderingContext2D, a: Crewmate): void {
  // Shadow.
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.beginPath();
  ctx.ellipse(a.x, a.y + a.radius * 0.75, a.radius * 1.0, a.radius * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body.
  ctx.fillStyle = a.color;
  ctx.beginPath();
  ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#0b1220";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Visor.
  ctx.fillStyle = "#e2f5ff";
  ctx.beginPath();
  ctx.arc(
    a.x + a.facingX * a.radius * 0.32,
    a.y + a.facingY * a.radius * 0.32,
    a.radius * 0.3,
    0,
    Math.PI * 2,
  );
  ctx.fill();

  // Task progress ring while working.
  if (a.state === "working" && a.taskProgress > 0) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(a.x, a.y, a.radius + 6, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "#ffb020";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(
      a.x,
      a.y,
      a.radius + 6,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * a.taskProgress,
    );
    ctx.stroke();
  }
}

function drawImposter(ctx: CanvasRenderingContext2D, a: Imposter): void {
  const venting = a.state === "venting";

  ctx.save();
  if (venting) ctx.globalAlpha = 0.38;

  // Shadow.
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.beginPath();
  ctx.ellipse(a.x, a.y + a.radius * 0.75, a.radius, a.radius * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();

  // Body.
  ctx.fillStyle = a.color;
  ctx.beginPath();
  ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2b0710";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Red visor (crewmate visors are pale).
  ctx.fillStyle = "#ff5a6e";
  ctx.beginPath();
  ctx.arc(
    a.x + a.facingX * a.radius * 0.32,
    a.y + a.facingY * a.radius * 0.32,
    a.radius * 0.3,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  ctx.restore();

  // Alert diamond marker above the head.
  ctx.fillStyle = venting ? "#ffb020" : "#ff4d6a";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y - a.radius - 14);
  ctx.lineTo(a.x + 6, a.y - a.radius - 8);
  ctx.lineTo(a.x, a.y - a.radius - 2);
  ctx.lineTo(a.x - 6, a.y - a.radius - 8);
  ctx.closePath();
  ctx.fill();
}

/** Dashed link from a stalking imposter to the crewmate it is following. */
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

/**
 * Draw the whole map into a canvas whose backing store is `cssW*dpr` by
 * `cssH*dpr`. World shapes are drawn under a scaled transform; labels are drawn
 * in screen space so text stays a constant, readable size.
 */
export interface Scene {
  player?: Player | null;
  crewmates?: Crewmate[];
  imposters?: Imposter[];
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  map: GameMap,
  cssW: number,
  cssH: number,
  dpr: number,
  scene: Scene = {},
): void {
  // Background (screen space, device-pixel scaled).
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.space;
  ctx.fillRect(0, 0, cssW, cssH);

  const t = computeTransform(map, cssW, cssH);

  // World-space shapes.
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

  for (const a of scene.imposters ?? []) {
    if (a.state !== "stalking" && a.state !== "observing") continue;
    const target = scene.crewmates?.find((c) => c.id === a.targetCrewmateId);
    if (target) drawStalkLink(ctx, a, target);
  }

  for (const a of scene.crewmates ?? []) drawCrewmate(ctx, a);
  for (const a of scene.imposters ?? []) drawImposter(ctx, a);
  if (scene.player) drawPlayer(ctx, scene.player);

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

  // Crewmate names.
  for (const a of scene.crewmates ?? []) {
    ctx.fillStyle = "rgba(203, 213, 225, 0.85)";
    ctx.font = '600 9px "JetBrains Mono", monospace';
    ctx.fillText(a.name, sx(a.x), sy(a.y) + a.radius + 12);
  }

  // Imposter names (tinted red to match their marker).
  for (const a of scene.imposters ?? []) {
    ctx.fillStyle = "rgba(255, 122, 146, 0.9)";
    ctx.font = '600 9px "JetBrains Mono", monospace';
    ctx.fillText(a.name, sx(a.x), sy(a.y) + a.radius + 12);
  }
}

/** Legend entries for the UI. */
export const MAP_LEGEND: { kind: PointOfInterest["kind"]; label: string }[] = [
  { kind: "task", label: "Task console" },
  { kind: "emergency", label: "Emergency beacon" },
  { kind: "vent", label: "Vent" },
  { kind: "sabotage", label: "Sabotage target" },
  { kind: "spawn", label: "Spawn point" },
];

export const POI_LEGEND_COLORS = POI_COLORS;
