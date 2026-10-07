/**
 * The recap: a finished match re-told as a story.
 *
 * A raw match is a pile of events; what makes a round of social deduction worth
 * watching is the *arc* — who was who, who struck first, who got caught, who got
 * blamed for it, and what the losers were really thinking while they said the
 * opposite. The end screen already shows the numbers; this module turns the
 * match timeline (`events.ts`) plus the agents' private thoughts (`confessional`)
 * into a short, ordered narrative with a spotlight on the decisive beat.
 *
 * It is pure: given the same record it always produces the same recap, so a
 * saved match re-narrates identically and the headless validator can pin it.
 * Nothing here reads the engine or wall-clock time.
 */

import type { MatchEvent, SabotageKind } from "./events";
import type { Role } from "./perception";

export interface RecapBeat {
  kind: "kill" | "sabotage" | "repair" | "meeting" | "eject" | "verdict";
  /** Simulation time in seconds. */
  t: number;
  /** Short all-caps tag, e.g. "SILENT KILL". */
  headline: string;
  /** The sentence the audience reads. */
  text: string;
  tone: "neutral" | "danger" | "good" | "bad";
}

export interface RecapSpotlight {
  label: string;
  text: string;
}

export interface RecapQuote {
  name: string;
  role: Role;
  /** True when the quote is a lie told to the room. */
  concealing: boolean;
  text: string;
}

export interface RecapStats {
  kills: number;
  silentKills: number;
  sabotages: number;
  meetings: number;
  ejects: number;
  /** Ejections of crew members — the wrong answers. */
  mislynches: number;
  /** Ejections of imposters — the right answers. */
  caught: number;
}

export interface Recap {
  /** e.g. "Imposter victory · 3:07". */
  title: string;
  beats: RecapBeat[];
  spotlight: RecapSpotlight | null;
  quote: RecapQuote | null;
  stats: RecapStats;
}

/** The slice of a `MatchRecord` the recap needs. Kept structural, not typed to it. */
export interface RecapInput {
  winner: "crew" | "imposter";
  durationSec: number;
  roster: { key: string; name: string; role: Role; alive?: boolean }[];
  events?: MatchEvent[];
  confessional?: {
    t: number;
    name: string;
    role: Role;
    action: string;
    thought: string;
  }[];
}

function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function sabotageWord(kind: SabotageKind): string {
  return kind === "meltdown" ? "reactor meltdown" : "lights out";
}

/** One narrative line per structured event. */
function beatFor(e: MatchEvent): RecapBeat | null {
  switch (e.kind) {
    case "kill":
      return {
        kind: "kill",
        t: e.t,
        headline: e.witnessed ? "KILL — SEEN" : "SILENT KILL",
        tone: e.witnessed ? "neutral" : "danger",
        text: e.witnessed
          ? `${e.killerName} killed ${e.victimName} in ${e.roomName} — and someone saw it.`
          : `${e.killerName} killed ${e.victimName} in ${e.roomName} — and nobody saw a thing.`,
      };
    case "sabotage":
      return {
        kind: "sabotage",
        t: e.t,
        headline: "SABOTAGE",
        tone: "danger",
        text: `The station was thrown into ${sabotageWord(e.sabotage)}.`,
      };
    case "repair":
      return {
        kind: "repair",
        t: e.t,
        headline: "REPAIRED",
        tone: "good",
        text:
          e.sabotage === "meltdown"
            ? "The crew reached both scanners in time — the meltdown was stopped."
            : "The crew got the lights back on.",
      };
    case "meeting":
      return {
        kind: "meeting",
        t: e.t,
        headline: "MEETING CONVENED",
        tone: "neutral",
        text:
          e.reason === "report"
            ? `${e.byName} reported a body. Everyone was called to the table.`
            : `${e.byName} slammed the emergency beacon.`,
      };
    case "eject":
      return {
        kind: "eject",
        t: e.t,
        headline: e.role === "imposter" ? "CAUGHT" : "MISLYNCH",
        tone: e.role === "imposter" ? "good" : "bad",
        text:
          e.role === "imposter"
            ? `${e.name} was voted out — and was an imposter.`
            : `${e.name} was voted out — and was innocent.`,
      };
    case "end":
      return {
        kind: "verdict",
        t: e.t,
        headline: "VERDICT",
        tone: e.winner === "crew" ? "good" : "danger",
        text: e.reason,
      };
    default:
      return null;
  }
}

/**
 * The single beat worth framing, chosen by a fixed priority so it never
 * flip-flops: a mislynch beats a clean kill beats the verdict.
 */
function pickSpotlight(events: MatchEvent[]): RecapSpotlight | null {
  const mislynch = [...events]
    .reverse()
    .find((e) => e.kind === "eject" && e.role === "crew") as
    | Extract<MatchEvent, { kind: "eject" }>
    | undefined;
  if (mislynch) {
    const hands = mislynch.voters.filter((v) => v !== mislynch.name).length;
    const who = mislynch.voters.filter((v) => v !== mislynch.name);
    return {
      label: "THE MISLYNCH",
      text:
        `${mislynch.name} was innocent, and the room turned on them` +
        (hands > 0 ? ` — ${who.slice(0, 3).join(", ")} led the vote.` : "."),
    };
  }

  const silent = events.find((e) => e.kind === "kill" && !e.witnessed) as
    | Extract<MatchEvent, { kind: "kill" }>
    | undefined;
  if (silent) {
    return {
      label: "THE CLEAN KILL",
      text: `${silent.killerName} took ${silent.victimName} in ${silent.roomName} with no one watching.`,
    };
  }

  const seen = events.find((e) => e.kind === "kill" && e.witnessed) as
    | Extract<MatchEvent, { kind: "kill" }>
    | undefined;
  if (seen) {
    return {
      label: "THE SLIP",
      text: `${seen.killerName} was seen killing ${seen.victimName} — the mistake that broke the round open.`,
    };
  }

  const end = events.find((e) => e.kind === "end") as
    | Extract<MatchEvent, { kind: "end" }>
    | undefined;
  if (end) {
    return { label: "THE VERDICT", text: end.reason };
  }
  return null;
}

/**
 * The line the audience takes away: a traitor's cover story if there is one,
 * otherwise a crewmate's read. Prefer a lie that *worked* — a concealing thought
 * from an agent who walked away alive — because that is the moment worth
 * replaying.
 */
function pickQuote(
  input: RecapInput,
  winner: "crew" | "imposter",
): RecapQuote | null {
  const entries = input.confessional ?? [];
  if (entries.length === 0) return null;

  const survivors = new Set(
    input.roster
      .filter((r) => r.role === "imposter" && r.alive !== false)
      .map((r) => r.name),
  );
  const concealing = entries.filter((e) => e.role === "imposter");
  const survivingLies = concealing.filter((e) => survivors.has(e.name));

  // Imposters won: frame the lie that carried them. Crew won: frame the read
  // that cracked it — either a traitor's last cover story, or, failing that,
  // the final crew line before the verdict.
  const chosen =
    (winner === "imposter" ? survivingLies.at(-1) ?? concealing.at(-1) : concealing.at(-1)) ??
    [...entries].reverse().find((e) => e.role === "crew") ??
    entries.at(-1)!;

  return {
    name: chosen.name,
    role: chosen.role,
    concealing: chosen.role === "imposter",
    text: chosen.thought,
  };
}

/**
 * Build the recap from a finished match. Returns `null` when the record predates
 * the structured timeline, so the end screen can simply hide the section.
 */
export function buildRecap(input: RecapInput): Recap | null {
  const events = input.events ?? [];
  if (events.length === 0) return null;

  const beats = events
    .map(beatFor)
    .filter((b): b is RecapBeat => b !== null);

  const stats: RecapStats = {
    kills: events.filter((e) => e.kind === "kill").length,
    silentKills: events.filter((e) => e.kind === "kill" && !e.witnessed).length,
    sabotages: events.filter((e) => e.kind === "sabotage").length,
    meetings: events.filter((e) => e.kind === "meeting").length,
    ejects: events.filter((e) => e.kind === "eject").length,
    mislynches: events.filter((e) => e.kind === "eject" && e.role === "crew").length,
    caught: events.filter((e) => e.kind === "eject" && e.role === "imposter").length,
  };

  return {
    title: `${input.winner === "crew" ? "Crew victory" : "Imposter victory"} · ${clock(input.durationSec)}`,
    beats,
    spotlight: pickSpotlight(events),
    quote: pickQuote(input, input.winner),
    stats,
  };
}
