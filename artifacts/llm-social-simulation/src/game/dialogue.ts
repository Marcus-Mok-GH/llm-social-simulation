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
    case "flag":
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
 *
 * `ctx.turn` (how many times this agent has spoken this meeting) rotates
 * through memories and phrasings, because agents now keep talking for the
 * whole discussion — a one-liner library would otherwise repeat verbatim.
 */
export function heuristicStatement(
  map: GameMap,
  mind: Mind,
  speaker: Speaker,
  names: NameIndex,
  ctx: { others: string[]; playerLine: string | null; turn?: number },
): Statement {
  const turn = ctx.turn ?? 0;
  const priority: MemoryEntry["kind"][] = ["kill", "vent", "flag", "body", "sabotage", "sighted", "task"];

  for (const kind of priority) {
    const matches: MemoryEntry[] = [];
    for (let i = mind.memories.length - 1; i >= 0; i--) {
      if (mind.memories[i].kind === kind) matches.push(mind.memories[i]);
    }
    if (matches.length === 0) continue;
    const line = memoryToLine(map, matches[turn % matches.length], speaker, names);
    if (!line) continue;
    const top = rankSuspects(mind, 0.2);
    return { line, accuse: top.length > 0 ? top[0].key : null };
  }

  const top = rankSuspects(mind, 0.18);
  if (top.length > 0) {
    const who = names[top[0].key] ?? top[0].key;
    const jabs = [
      `No proof yet, but ${who} is who I'd watch.`,
      `Still no proof, but keep an eye on ${who}.`,
      `If you ask me, ${who} is the one acting strange.`,
    ];
    return { line: jabs[turn % jabs.length], accuse: top[0].key };
  }

  if (ctx.playerLine && mind.role === "imposter") {
    // Imposters deflect rather than agree.
    const target = ctx.others.find((k) => k !== mind.key && !mind.allies.includes(k));
    if (target) {
      const who = names[target] ?? target;
      const deflects = [
        `That's a deflection — ${who} was nowhere near it.`,
        `Convenient story. ${who} is the one steering us in circles.`,
        `Don't follow that. Where was ${who}, exactly?`,
      ];
      return { line: deflects[turn % deflects.length], accuse: target };
    }
  }

  if (ctx.playerLine && mind.role === "crew") {
    // Crew acknowledge the human before falling back to an alibi.
    const acks = [
      "Fair. My read hasn't changed though — I've got nothing new.",
      "I hear you. If anyone saw something, now's the time.",
      "Maybe. I'd still like to hear where everyone actually was.",
    ];
    return { line: acks[turn % acks.length], accuse: null };
  }

  const alibis = [
    "I was on tasks the whole time, I didn't see anything.",
    "No idea. I kept my head down and worked.",
    "Whoever it was, they moved fast — I lost them in the corridors.",
  ];
  const idx = Math.abs(mind.key.length * 7 + mind.memories.length + turn) % alibis.length;
  return { line: alibis[idx], accuse: null };
}

/**
 * Self-description used in the LLM system prompt. By default the agent's whole
 * match-long memory is included — nothing is dropped, so a meeting statement
 * can cite anything the agent has seen since the round began. Pass `limit` to
 * bound it when a caller only needs the tail.
 */
export function memoryDigest(
  map: GameMap,
  mind: Mind,
  names: NameIndex,
  limit?: number,
): string[] {
  const items = limit === undefined ? mind.memories : mind.memories.slice(-limit);
  const out: string[] = [];
  for (const m of items) {
    const line = memoryToLine(map, m, { key: "x", name: "You" }, names);
    if (line) out.push(`[${m.kind}] ${line}`);
  }
  return out;
}
