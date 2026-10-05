/**
 * The spatial node graph (PLAN.md step 1).
 *
 * Raw X/Y coordinates are hard for a language model to reason about, so the
 * engine divides the deck into a *node graph* of discrete zones instead:
 * every room and every corridor is a node, and a corridor links every room it
 * opens onto (the Skeld's corridors are hubs — the west hall joins four rooms).
 * An agent is always "in" exactly one zone, and movement is asked for as a
 * destination zone ("MOVE to Electrical") rather than a pixel target.
 *
 * `navigation.ts` still owns the physical route — the zone graph only decides
 * *which* zone an agent wants and validates that the choice is connected.
 */

import { nearestStandable, type Vec2 } from "./collision";
import { type GameMap, type RoomId } from "./map";

export type ZoneKind = "room" | "corridor";

export interface Zone {
  /** RoomId for a room, corridor id for a corridor. Unique. */
  id: string;
  kind: ZoneKind;
  name: string;
  short: string;
  /** The room this zone belongs to (a corridor reports the first room it joins). */
  roomId: RoomId;
  /** Centre used as an A* destination for this zone. */
  cx: number;
  cy: number;
  /** Task consoles physically inside this zone. */
  taskPoiIds: string[];
  /** Vent POIs physically inside this zone. */
  ventPoiIds: string[];
}

export interface ZoneGraph {
  order: string[];
  zones: Record<string, Zone>;
  /** zone id -> directly connected zone ids. */
  edges: Record<string, string[]>;
  /** lowercased name/short/id -> zone id, for resolving model output. */
  lookup: Record<string, string>;
}

function contains(x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Build the room/corridor node graph from the map data. */
export function buildZoneGraph(map: GameMap): ZoneGraph {
  const zones: Record<string, Zone> = {};
  const order: string[] = [];
  const edges: Record<string, string[]> = {};
  const lookup: Record<string, string> = {};

  const register = (zone: Zone): void => {
    zones[zone.id] = zone;
    order.push(zone.id);
    edges[zone.id] = [];
    lookup[zone.id.toLowerCase()] = zone.id;
    lookup[zone.name.toLowerCase()] = zone.id;
    lookup[zone.short.toLowerCase()] = zone.id;
  };

  for (const r of map.rooms) {
    register({
      id: r.id,
      kind: "room",
      name: r.name,
      short: r.short,
      roomId: r.id,
      cx: r.x + r.w / 2,
      cy: r.y + r.h / 2,
      taskPoiIds: map.pointsOfInterest
        .filter((p) => p.kind === "task" && contains(p.x, p.y, r))
        .map((p) => p.id),
      ventPoiIds: map.pointsOfInterest
        .filter((p) => p.kind === "vent" && contains(p.x, p.y, r))
        .map((p) => p.id),
    });
  }

  for (const c of map.corridors) {
    const [first] = c.connects;
    register({
      id: c.id,
      kind: "corridor",
      name: c.name ?? c.connects.join(" ↔ "),
      short: c.id,
      roomId: first,
      cx: c.x + c.w / 2,
      cy: c.y + c.h / 2,
      taskPoiIds: [],
      ventPoiIds: [],
    });
  }

  // A corridor is the hub that joins every room node it opens onto.
  for (const c of map.corridors) {
    if (!zones[c.id]) continue;
    const joined = c.connects.filter((id) => zones[id]);
    if (joined.length !== c.connects.length) continue;
    for (const id of joined) {
      edges[c.id].push(id);
      edges[id].push(c.id);
    }
  }

  return { order, zones, edges, lookup };
}

export function zoneById(graph: ZoneGraph, id: string): Zone | undefined {
  return graph.zones[id];
}

/** Resolve a zone from an id, full name or short label (case-insensitive). */
export function zoneByRef(graph: ZoneGraph, ref: string): Zone | undefined {
  if (graph.zones[ref]) return graph.zones[ref];
  const id = graph.lookup[ref.trim().toLowerCase()];
  return id ? graph.zones[id] : undefined;
}

export function zoneNeighbors(graph: ZoneGraph, id: string): Zone[] {
  return (graph.edges[id] ?? []).map((n) => graph.zones[n]).filter(Boolean);
}

/** Which zone a world point sits in. Rooms win over corridors at their shared seam. */
export function zoneAtPoint(graph: ZoneGraph, map: GameMap, x: number, y: number): Zone {
  for (const r of map.rooms) {
    if (contains(x, y, r)) return graph.zones[r.id];
  }
  for (const c of map.corridors) {
    if (contains(x, y, c)) return graph.zones[c.id];
  }
  // Between rectangles (shouldn't happen for legal positions): nearest centre.
  let best = graph.zones[graph.order[0]];
  let bestD = Infinity;
  for (const id of graph.order) {
    const z = graph.zones[id];
    const d = Math.hypot(z.cx - x, z.cy - y);
    if (d < bestD) {
      bestD = d;
      best = z;
    }
  }
  return best;
}

/** Breadth-first route through the graph, inclusive of both ends. */
export function zonePath(graph: ZoneGraph, from: string, to: string): Zone[] | null {
  if (!graph.zones[from] || !graph.zones[to]) return null;
  if (from === to) return [graph.zones[from]];

  const prev: Record<string, string | null> = { [from]: null };
  const queue: string[] = [from];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (cur === to) break;
    for (const next of graph.edges[cur] ?? []) {
      if (prev[next] !== undefined) continue;
      prev[next] = cur;
      queue.push(next);
    }
  }
  if (prev[to] === undefined) return null;

  const path: Zone[] = [];
  let node: string | null = to;
  while (node) {
    path.push(graph.zones[node]);
    node = prev[node] ?? null;
  }
  return path.reverse();
}

/** A walkable point inside a zone, used as the A* destination for a MOVE. */
export function standPoint(map: GameMap, zone: Zone, radius = 15): Vec2 {
  return nearestStandable(map, zone.cx, zone.cy, radius);
}

/** Simulation clock as "MM:SS", the `current_time` the AI is shown. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm.toString().padStart(2, "0")}:${ss.toString().padStart(2, "0")}`;
}
