/**
 * Meeting dialogue.
 *
 * The heuristic (no-model) statement generator is the fallback for the LLM, but
 * it is not a placeholder: it is built from the same `Mind` the model reads, so
 * an agent that says "I saw SHADE by the vents" is saying it because SHADE is
 * genuinely who it suspects. That keeps meetings readable when the model is
 * slow, offline, or turned off.
 */

import { rankSuspects, type MemoryEntry, type Mind } from "./perception";
import { roomById, type GameMap, type RoomId } from "./map";

/** key -> display name, so memory text reads like speech rather than ids. */
export type NameIndex = Record<string, string>;

export interface Statement {
  line: string;
  /** Who the speaker is pushing the room toward ejecting (null = abstain). */
  accuse: string | null;
}

export interface Speaker {
  key: string;
  name: string;
}

function roomName(map: GameMap, roomId: RoomId): string {
  return roomById(map, roomId)?.name ?? roomId;
}

/** Turn a memory into a first-person sentence. */
export function memoryToLine(
  map: GameMap,
  m: MemoryEntry,
  speaker: Speaker,
  names: NameIndex,
): string | null {
  const where = roomName(map, m.roomId);
  const who = names[m.actorKey] ?? m.actorKey;

  switch (m.kind) {
    case "kill":
      return `${speaker.name}: I watched ${who} kill someone in ${where}.`;
    case "body":
      return `I found a body in ${where}.`;
    case "vent":
      return `${who} used a vent in ${where}. Nobody else can do that.`;
    case "sabotage":
      return `${who} triggered the sabotage. I'd look at them first.`;
    case "task":
      return `I saw ${who} working a console in ${where} — looked legit.`;
    case "claim":
      return m.text;
    case "report":
    case "eject":
      return null;
    case "sighted":
    default:
      return `I saw ${who} in ${where} not long ago.`;
  }
}

/**
 * Pick a line: prefer the most incriminating recent memory, otherwise fall
 * back to a suspicion-based accusation, otherwise an alibi.
 */
export function heuristicStatement(
  map: GameMap,
  mind: Mind,
  speaker: Speaker,
  names: NameIndex,
  ctx: { others: string[]; playerLine: string | null },
): Statement {
  const priority: MemoryEntry["kind"][] = ["kill", "vent", "body", "sabotage", "sighted", "task"];

  for (const kind of priority) {
    for (let i = mind.memories.length - 1; i >= 0; i--) {
      const m = mind.memories[i];
      if (m.kind !== kind) continue;
      const line = memoryToLine(map, m, speaker, names);
      if (!line) continue;
      const top = rankSuspects(mind, 0.2);
      return { line, accuse: top.length > 0 ? top[0].key : null };
    }
  }

  const top = rankSuspects(mind, 0.18);
  if (top.length > 0) {
    return {
      line: `No proof yet, but ${names[top[0].key] ?? top[0].key} is who I'd watch.`,
      accuse: top[0].key,
    };
  }

  if (ctx.playerLine && mind.role === "imposter") {
    // Imposters deflect rather than agree.
    const target = ctx.others.find((k) => k !== mind.key && !mind.allies.includes(k));
    if (target) {
      return { line: `That's a deflection — ${names[target] ?? target} was nowhere near it.`, accuse: target };
    }
  }

  const alibis = [
    "I was on tasks the whole time, I didn't see anything.",
    "No idea. I kept my head down and worked.",
    "Whoever it was, they moved fast — I lost them in the corridors.",
  ];
  const idx = Math.abs(mind.key.length + mind.memories.length) % alibis.length;
  return { line: alibis[idx], accuse: null };
}

/** Short self-description used in the LLM system prompt. */
export function memoryDigest(
  map: GameMap,
  mind: Mind,
  names: NameIndex,
  limit = 8,
): string[] {
  const out: string[] = [];
  for (const m of mind.memories.slice(-limit)) {
    const line = memoryToLine(map, m, { key: "x", name: "You" }, names);
    if (line) out.push(`[${m.kind}] ${line}`);
  }
  return out;
}
