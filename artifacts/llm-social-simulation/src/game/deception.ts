/**
 * Deception and identification.
 *
 * A social-deduction cast is only interesting when the traitors can actually
 * lie and the crew can actually catch them. This module owns that trade:
 *
 *   - **Personas.** Every traitor is given a deception style at roster build,
 *     which flavours both its private playbook (in the model prompt) and how it
 *     fabricates claims offline.
 *   - **Claims.** A meeting statement may carry a structured public claim —
 *     `accuse` someone, `vouch` for someone, or hand out an `alibi`. Dozens of
 *     words of prose are hard to act on; a claim is something every listener's
 *     belief model can weigh.
 *   - **Judging.** `judgeClaim` is the crew's defence: it checks a claim against
 *     what *this* listener personally saw. A claim that clashes with the
 *     listener's own memory doesn't just get ignored — it brands the speaker a
 *     liar (`caught`), which is how the crew identifies the traitors.
 *
 * Everything here is pure: no engine, no clock, no React. The engine decides
 * who spoke and hands the result to `perception.remember`, which remains the
 * only thing that moves a belief.
 */

import { hashString } from "./rng";
import { roomById, type GameMap, type RoomId } from "./map";
import { rankSuspects, type Mind } from "./perception";

// ---------------------------------------------------------------------------
// Personalities
// ---------------------------------------------------------------------------

/**
 * The deception playbooks a traitor can be handed. They are deliberately
 * different *social* strategies rather than difficulty levels: a bold
 * provocateur and a quiet ghost both win some shifts.
 */
export type DeceptionStyle = "wire-puller" | "provocateur" | "confidant" | "ghost";

export interface DeceptionPersona {
  style: DeceptionStyle;
  /** Human-readable label for the confessional / briefings. */
  label: string;
  /** Guidance injected into the traitor's decision and meeting prompts. */
  playbook: string;
}

export const DECEPTION_PERSONAS: Record<DeceptionStyle, DeceptionPersona> = {
  "wire-puller": {
    style: "wire-puller",
    label: "Wire-puller",
    playbook:
      "You are a patient wire-puller: keep a spotless alibi, stay calm and unhurried, and steer the room onto an innocent with a plausible half-truth. Never repeat a lie the room has already questioned — change tack instead.",
  },
  provocateur: {
    style: "provocateur",
    label: "Provocateur",
    playbook:
      "You are bold and theatrical: accuse early and loudly, invent sightings, and dare the room to doubt you. Pick one crewmate to frame and press it until the room is arguing about them instead of you.",
  },
  confidant: {
    style: "confidant",
    label: "Confidant",
    playbook:
      "You are everyone's friend: vouch for people, build trust, and only frame someone once the room already doubts them. Defend your fellow traitor as if you honestly believe them.",
  },
  ghost: {
    style: "ghost",
    label: "Ghost",
    playbook:
      "You are quiet and hard to read: give a clean alibi, agree with the room's consensus and let others do the accusing. Say as little as you can get away with.",
  },
};

const STYLE_ORDER: DeceptionStyle[] = ["wire-puller", "provocateur", "confidant", "ghost"];

/** Deterministic style for traitor `index`, so a seed replays identically. */
export function styleForIndex(index: number): DeceptionStyle {
  const n = STYLE_ORDER.length;
  return STYLE_ORDER[((index % n) + n) % n];
}

export function personaFor(style: DeceptionStyle): DeceptionPersona {
  return DECEPTION_PERSONAS[style];
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export type ClaimKind = "accuse" | "vouch" | "alibi";

/**
 * A public assertion an agent makes in a meeting. `about` is always an actor
 * key: the accused/vouched player, or the speaker themself for an alibi.
 * A claim may name a room; when it does, listeners can check it against where
 * they actually last saw that player — which is what makes it falsifiable.
 */
export interface Claim {
  kind: ClaimKind;
  about: string;
  roomId?: RoomId;
  /** Short human detail ("faked a task", "was by the body"). */
  detail?: string;
}

export const CLAIM_KINDS: ClaimKind[] = ["accuse", "vouch", "alibi"];

export function isClaimKind(value: string): value is ClaimKind {
  return (CLAIM_KINDS as string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Judging a claim against one listener's own memory
// ---------------------------------------------------------------------------

/**
 * How recent a sighting must be for it to falsify a claim about the last few
 * seconds. Meetings freeze everyone, so a listener's last `lastSeen` entry for
 * a speaker is already "where I last had eyes on them, just before we sat down".
 */
const SIGHTING_WINDOW_SECONDS = 30;

export type ContradictionReason =
  | "self"
  | "alibi"
  | "accused-elsewhere"
  | "vouched-for-traitor";

export interface ClaimVerdict {
  /** True when the listener's own memory proves the claim false. */
  contradicted: boolean;
  reason: ContradictionReason | null;
  /** The room the listener's own sighting points at, when the clash is spatial. */
  sawRoomId: RoomId | null;
  /** The first-hand evidence that exposes a vouch, when there is any. */
  evidence: "vent" | "kill" | null;
}

const NO_VERDICT: ClaimVerdict = {
  contradicted: false,
  reason: null,
  sawRoomId: null,
  evidence: null,
};

/**
 * Judge a claim against one listener's memory. Pure.
 *
 * The rules are the crew's whole defence:
 *  - an accusation aimed at *me* is a lie I can always detect, because I know
 *    what I did not do;
 *  - an alibi or an accusation that names a room is checked against where I
 *    last saw that player;
 *  - vouching for someone I personally watched kill or vent is an admission.
 */
export function judgeClaim(
  mind: Mind,
  speakerKey: string,
  claim: Claim,
  now: number,
): ClaimVerdict {
  if (claim.kind === "accuse" && claim.about === mind.key) {
    return { contradicted: true, reason: "self", sawRoomId: null, evidence: null };
  }

  if (claim.kind === "alibi") {
    const seen = mind.lastSeen[speakerKey];
    if (seen && claim.roomId && seen.roomId !== claim.roomId && now - seen.t <= SIGHTING_WINDOW_SECONDS) {
      return { contradicted: true, reason: "alibi", sawRoomId: seen.roomId, evidence: null };
    }
    return NO_VERDICT;
  }

  if (claim.kind === "accuse") {
    if (claim.roomId) {
      const seen = mind.lastSeen[claim.about];
      if (seen && seen.roomId !== claim.roomId && now - seen.t <= SIGHTING_WINDOW_SECONDS) {
        return { contradicted: true, reason: "accused-elsewhere", sawRoomId: seen.roomId, evidence: null };
      }
    }
    return NO_VERDICT;
  }

  // vouch: backing someone the listener personally watched incriminate themself.
  const damning = mind.memories.find(
    (m) => m.actorKey === claim.about && (m.kind === "vent" || m.kind === "kill"),
  );
  if (damning) {
    return {
      contradicted: true,
      reason: "vouched-for-traitor",
      sawRoomId: null,
      evidence: damning.kind === "vent" ? "vent" : "kill",
    };
  }
  return NO_VERDICT;
}

// ---------------------------------------------------------------------------
// Memory text — full sentences, because `memoryToLine` quotes them verbatim
// ---------------------------------------------------------------------------

export type NameIndex = Record<string, string>;

function roomName(map: GameMap, roomId: RoomId | null | undefined): string | null {
  if (!roomId) return null;
  return roomById(map, roomId)?.name ?? roomId;
}

function who(names: NameIndex, key: string): string {
  return names[key] ?? key;
}

/** The public memory a listener banks when a claim lands unchallenged. */
export function claimMemoryText(
  map: GameMap,
  speakerName: string,
  claim: Claim,
  names: NameIndex,
): string {
  const target = who(names, claim.about);
  const room = roomName(map, claim.roomId);
  switch (claim.kind) {
    case "accuse":
      return room
        ? `${speakerName} accused ${target} of being in ${room}.`
        : `${speakerName} accused ${target} of ${claim.detail ?? "acting suspiciously"}.`;
    case "vouch":
      return `${speakerName} vouched that ${target} ${claim.detail ?? "could be trusted"}.`;
    case "alibi":
      return `${speakerName} claimed they were in ${room ?? "their task room"} the whole time.`;
  }
}

/** The memory a listener banks when its own eyes expose the speaker. */
export function contradictionNote(
  map: GameMap,
  speakerName: string,
  claim: Claim,
  verdict: ClaimVerdict,
  names: NameIndex,
): string {
  const target = who(names, claim.about);
  const saw = roomName(map, verdict.sawRoomId);
  switch (verdict.reason) {
    case "self":
      return `${speakerName} accused me of something I know I did not do.`;
    case "alibi":
      return `${speakerName} said they were in ${roomName(map, claim.roomId) ?? "another room"}, but I saw them in ${saw ?? "elsewhere"}.`;
    case "accused-elsewhere":
      return `${speakerName} claimed ${target} was in ${roomName(map, claim.roomId) ?? "another room"}, but I saw ${target} in ${saw ?? "elsewhere"}.`;
    case "vouched-for-traitor":
      return `${speakerName} vouched for ${target}, but I watched ${target} ${verdict.evidence === "vent" ? "use a vent" : "kill someone"}.`;
    default:
      return `${speakerName}'s story does not add up.`;
  }
}

/**
 * The spoken line that matches a claim. Kept next to the claim types so a
 * scripted line can never contradict the structured claim it ships with.
 */
export function claimLine(
  map: GameMap,
  claim: Claim,
  names: NameIndex,
  seed: number,
): string {
  const target = who(names, claim.about);
  const room = roomName(map, claim.roomId);
  switch (claim.kind) {
    case "accuse": {
      if (claim.detail === "lied about where they were") {
        return `That doesn't hold up — I saw ${target} somewhere else when they said otherwise.`;
      }
      if (room) {
        const variants = [
          `I had eyes on ${target} in ${room} — that's not where they said they were.`,
          `${target} was in ${room}. Ask them why they won't admit it.`,
        ];
        return variants[seed % variants.length];
      }
      const variants = [
        `I don't trust ${target}. They ${claim.detail ?? "were acting strange"}.`,
        `${target} is the one I'd watch — ${claim.detail ?? "something is off"}.`,
      ];
      return variants[seed % variants.length];
    }
    case "vouch":
      return `${target} is clear — I ${claim.detail ?? "was with them"}.`;
    case "alibi":
      return room ? `I was in ${room} the whole time, on my tasks.` : `I was on tasks the whole time.`;
  }
}

// ---------------------------------------------------------------------------
// Fabrication (the offline / heuristic traitor)
// ---------------------------------------------------------------------------

/** Context a speaker needs to invent a claim about the room it is standing in. */
export interface ClaimContext {
  /** Living actor keys, from the speaker's own view. */
  others: string[];
  /** key -> display name. */
  names: NameIndex;
  /** The speaker's own key (the target of an alibi). */
  selfKey: string;
  /** A seed that varies per statement — the meeting turn number works well. */
  seed: number;
  /**
   * How many times the speaker has already spoken this meeting. A traitor
   * spends its lies early and then goes quiet: every fresh accusation buys a
   * new enemy, so inventing one on every turn is how a traitor gets itself
   * ejected before it has done any real damage.
   */
  turn: number;
  /** Room to claim when offering an alibi (where the traitor faked work). */
  alibiRoomId?: RoomId | null;
}

const ACCUSE_DETAILS = [
  "was faking a task",
  "was near the body",
  "slipped into a vent",
  "was following me",
  "was loitering by the panel",
];

/** Deterministic [0,1) roll from the speaker's key and the statement seed. */
function roll(...parts: (string | number)[]): number {
  return (hashString(parts.join("|")) >>> 0) / 4294967296;
}

function pickOne<T>(arr: readonly T[], parts: (string | number)[]): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(roll(...parts) * arr.length)];
}

/**
 * Invent a claim for a scripted traitor. It never names an ally and never names
 * itself as the accused. The careful personas smear without a location to
 * check; only the provocateur hands out a room or an alibi — the checkable lie
 * a crew can catch, and the reason a provocateur lives dangerously.
 */
export function fabricateClaim(
  style: DeceptionStyle,
  mind: Mind,
  map: GameMap,
  ctx: ClaimContext,
): Claim | null {
  const targets = ctx.others.filter((k) => k !== ctx.selfKey && !mind.allies.includes(k));
  const ally = pickOne(
    mind.allies.filter((k) => k !== ctx.selfKey && ctx.others.includes(k)),
    [mind.key, ctx.seed, "ally"],
  );
  const target = pickOne(targets, [mind.key, ctx.seed, "target"]);
  const detail = pickOne(ACCUSE_DETAILS, [mind.key, ctx.seed, "detail"]) ?? undefined;
  // Naming a room makes an accusation falsifiable, so only the provocateur
  // takes that risk; the careful personas smear without a location to check.
  const roomId =
    style === "provocateur" && roll(mind.key, ctx.seed, "room?") < 0.35
      ? pickOne(map.rooms, [mind.key, ctx.seed, "room"])?.id
      : undefined;
  const alibiRoomId =
    ctx.alibiRoomId ?? pickOne(map.rooms, [mind.key, ctx.seed, "alibi"])?.id ?? undefined;
  // Lies are front-loaded: after a couple of turns the traitor stops inventing
  // new accusations and lets the room argue among itself.
  const canAccuse = ctx.turn <= 2;

  const r = roll(mind.key, ctx.seed, "style");
  switch (style) {
    case "provocateur":
      if (target && canAccuse && r < 0.85) return { kind: "accuse", about: target, roomId, detail };
      return alibiRoomId ? { kind: "alibi", about: ctx.selfKey, roomId: alibiRoomId } : null;
    case "wire-puller": {
      if (target && canAccuse && r < 0.55) return { kind: "accuse", about: target, roomId, detail };
      if (ally && r < 0.8) return { kind: "vouch", about: ally, detail: "was on tasks" };
      return null;
    }
    case "confidant": {
      if (ally && r < 0.45) return { kind: "vouch", about: ally, detail: "was on tasks" };
      if (target && canAccuse && r < 0.75) return { kind: "accuse", about: target, roomId, detail };
      return null;
    }
    case "ghost": {
      if (target && canAccuse && r < 0.6) return { kind: "accuse", about: target, detail };
      return null;
    }
  }
}

/**
 * The claim an honest crew member makes: first whatever it caught a liar
 * doing, then its own first-hand evidence, then a spoken suspicion — and
 * occasionally a vouch that clears someone it was standing with. Crew clear
 * crew, which is the counterweight to the traitors' framing.
 */
export function crewClaim(mind: Mind, ctx: ClaimContext): Claim | null {
  // 1. A liar this crew member already caught is its strongest lead.
  for (let i = mind.memories.length - 1; i >= 0; i--) {
    const m = mind.memories[i];
    if (m.kind === "caught") {
      return { kind: "accuse", about: m.actorKey, detail: "lied about where they were" };
    }
  }

  // 2. First-hand evidence — a kill or a vent it actually watched.
  for (let i = mind.memories.length - 1; i >= 0; i--) {
    const m = mind.memories[i];
    if (m.kind === "kill" || m.kind === "vent") {
      return {
        kind: "accuse",
        about: m.actorKey,
        roomId: m.roomId,
        detail: m.kind === "kill" ? "killed someone" : "used a vent",
      };
    }
  }

  // 3. A real suspicion, spoken aloud to put pressure on it. Front-loaded like
  //    the traitors' lies, so a crew doesn't spam accusations forever.
  const top = rankSuspects(mind, 0.15)[0];
  if (top && ctx.turn <= 2 && roll(mind.key, ctx.seed, "press") < 0.7) {
    return { kind: "accuse", about: top.key, detail: "was acting strange" };
  }

  // 4. Occasionally back someone up instead of accusing.
  const seen = Object.entries(mind.lastSeen)
    .filter(([k]) => k !== ctx.selfKey && !mind.allies.includes(k))
    .sort((a, b) => b[1].t - a[1].t)[0];
  if (seen && roll(mind.key, ctx.seed, "vouch") < 0.35) {
    return { kind: "vouch", about: seen[0], detail: "was with me" };
  }
  return null;
}
