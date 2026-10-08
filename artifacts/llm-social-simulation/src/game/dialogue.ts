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
import { hashString } from "./rng";
import {
  claimLine,
  crewClaim,
  fabricateClaim,
  personaFor,
  type Claim,
  type ClaimContext,
  type DeceptionStyle,
} from "./deception";

/** key -> display name, so memory text reads like speech rather than ids. */
export type NameIndex = Record<string, string>;

export interface Statement {
  /** What the agent said out loud, in the meeting. */
  line: string;
  /**
   * What the agent was actually thinking while it said that — the private
   * confessional the audience gets to read. Only a live model produces one;
   * the engine synthesises a stand-in for heuristic lines.
   */
  thinking?: string | null;
  /**
   * A structured public assertion the line makes — who it accuses, who it
   * vouches for, or the alibi it claims. This is what the engine hands to every
   * listener's belief model, so a lie can actually move the room (and be caught).
   */
  claim?: Claim | null;
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
      return `I watched ${who} kill someone in ${where}.`;
    case "body":
      return `I found a body in ${where}.`;
    case "vent":
      return `${who} used a vent in ${where}. Nobody else can do that.`;
    case "sabotage":
      return `${who} triggered the sabotage. I'd look at them first.`;
    case "task":
      return `I saw ${who} working a console in ${where} — looked legit.`;
    case "log":
      return m.text;
    case "flag":
      return m.text;
    // Claims and caught lies are already written as full sentences by
    // `game/deception.ts`, so they are quoted verbatim rather than rephrased.
    case "accuse":
    case "vouch":
    case "caught":
    case "reveal":
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
 * Pick a line: prefer the most incriminating recent memory, otherwise a
 * suspicion-driven jab, otherwise an alibi. Agents speak for themselves — the
 * engine never attaches an accusation target to what they say.
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
  ctx: {
    others: string[];
    playerLine: string | null;
    turn?: number;
    /** Where a scripted traitor claims it was working, for its alibi. */
    alibiRoomId?: RoomId | null;
    /** The traitor's deception persona, when it has one. */
    style?: DeceptionStyle | null;
  },
): Statement {
  const turn = ctx.turn ?? 0;

  // A claim is the social move: a traitor frames or defends, a crewmate
  // presses its evidence. When there is one, the line is generated from it so
  // the spoken words and the structured claim can never disagree.
  const claimCtx: ClaimContext = {
    others: ctx.others,
    names,
    selfKey: mind.key,
    seed: turn * 7 + mind.memories.length,
    turn,
    alibiRoomId: ctx.alibiRoomId ?? null,
  };
  const claim =
    mind.role === "imposter"
      ? fabricateClaim(ctx.style ?? "wire-puller", mind, map, claimCtx)
      : crewClaim(mind, claimCtx);
  if (claim) {
    return { line: claimLine(map, claim, names, turn), claim };
  }

  const priority: MemoryEntry["kind"][] = ["kill", "vent", "flag", "body", "sabotage", "sighted", "task"];

  for (const kind of priority) {
    const matches: MemoryEntry[] = [];
    for (let i = mind.memories.length - 1; i >= 0; i--) {
      if (mind.memories[i].kind === kind) matches.push(mind.memories[i]);
    }
    if (matches.length === 0) continue;
    const line = memoryToLine(map, matches[turn % matches.length], speaker, names);
    if (!line) continue;
    return { line };
  }

  const top = rankSuspects(mind, 0.18);
  if (top.length > 0) {
    const who = names[top[0].key] ?? top[0].key;
    const jabs = [
      `No proof yet, but ${who} is who I'd watch.`,
      `Still no proof, but keep an eye on ${who}.`,
      `If you ask me, ${who} is the one acting strange.`,
    ];
    return { line: jabs[turn % jabs.length] };
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
      return { line: deflects[turn % deflects.length] };
    }
  }

  if (ctx.playerLine && mind.role === "crew") {
    // Crew acknowledge the human before falling back to an alibi.
    const acks = [
      "Fair. My read hasn't changed though — I've got nothing new.",
      "I hear you. If anyone saw something, now's the time.",
      "Maybe. I'd still like to hear where everyone actually was.",
    ];
    return { line: acks[turn % acks.length] };
  }

  const alibis = [
    "I was on tasks the whole time, I didn't see anything.",
    "No idea. I kept my head down and worked.",
    "Whoever it was, they moved fast — I lost them in the corridors.",
  ];
  const idx = Math.abs(mind.key.length * 7 + mind.memories.length + turn) % alibis.length;
  return { line: alibis[idx] };
}

/**
 * A private thought for an agent that did not come from a model.
 *
 * The confessional panel must never be empty just because no key is configured:
 * the whole point is that the audience can hear what an agent really thinks,
 * and the scripted beliefs already know that. Impostors get a cover-story line,
 * crew get their genuine read of the room.
 */
export function confessionalFallback(
  mind: Mind,
  names: NameIndex,
  style?: DeceptionStyle | null,
): string {
  const top = rankSuspects(mind, 0.12)[0];
  const who = top ? names[top.key] ?? top.key : null;

  if (mind.role === "imposter") {
    // The persona only flavours *how* the cover story is told; every traitor
    // still deflects and protects its team.
    const as = style ? `Play the ${personaFor(style).label.toLowerCase()}: ` : "";
    if (mind.allies.length > 0) {
      const ally = names[mind.allies[0]] ?? mind.allies[0];
      return who
        ? `${as}keep it steady — let ${who} take the heat, and never cross ${ally}.`
        : `${as}keep it steady. ${ally} and I just need one clean kill.`;
    }
    return who
      ? `${as}say nothing useful. ${who} is the name the room wants to hear.`
      : `${as}say nothing useful. Let the room fill the silence itself.`;
  }

  if (who) return `No proof yet — but I keep coming back to ${who}.`;
  if (mind.memories.length === 0) return "Haven't seen anything. I need eyes on the halls.";
  return "Nothing adds up yet. I'll keep watching where people actually walk.";
}

/**
 * A candid line for the ghost channel.
 *
 * The dead have nothing left to hide: this is the one lane where an agent can
 * simply say what it saw and who it suspects, with no audience to manage. It is
 * deliberately model-free (the channel is flavour, not a spend) and pure, so a
 * replayed shift ghosts identically.
 */
export function ghostStatement(
  map: GameMap,
  mind: Mind,
  speaker: Speaker,
  names: NameIndex,
  index: number,
): string {
  const name = (key: string): string => names[key] ?? key;
  const pick = (variants: string[]): string =>
    variants[Math.abs(hashString(`${mind.key}|${index}|${mind.memories.length}`)) % variants.length];

  // First-hand evidence is the ghost's strongest line — it can finally say it
  // out loud.
  for (let i = mind.memories.length - 1; i >= 0; i--) {
    const m = mind.memories[i];
    if (m.kind === "kill") {
      return `It was ${name(m.actorKey)}. I watched them do it in ${roomName(map, m.roomId)}.`;
    }
    if (m.kind === "vent") {
      return `${name(m.actorKey)} uses the vents — I saw it in ${roomName(map, m.roomId)}.`;
    }
  }
  for (let i = mind.memories.length - 1; i >= 0; i--) {
    const m = mind.memories[i];
    if (m.kind === "caught") {
      return `${name(m.actorKey)} lied to the room. I never got to say it out there.`;
    }
  }

  const top = rankSuspects(mind, 0.08)[0];
  if (top) {
    return pick([
      `My read was always ${name(top.key)}. I'd have voted them.`,
      `${name(top.key)} is the one I'd be watching.`,
      `Watch ${name(top.key)}. I had a bad feeling about them.`,
    ]);
  }
  return pick([
    `${speaker.name}, signing off.`,
    "Nobody ever listens to the dead.",
    "At least the station log keeps my work on the record.",
    "Wish I could tell them who it was.",
    "Cold out here. Quiet.",
    "Whoever's left had better not blow it.",
  ]);
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
