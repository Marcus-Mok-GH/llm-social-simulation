/**
 * Generative "station log" consoles.
 *
 * A handful of the deck's task consoles are not timed busywork: they ask the
 * agent *to produce something* — a scan readout, an intercept summary, a note
 * on what was clogging the filter. The engine turns the agent's answer into a
 * public station-log entry that every other agent can read back in a meeting,
 * so the content an AI writes is part of the game rather than decoration.
 *
 * Cost is the whole reason this module exists: a log entry is text, never an
 * image or a minigame, and the number of *model* calls a match may spend on it
 * is capped by `LOG_MODEL_CALLS_MAX`. Anything past that budget (or with no key
 * at all) falls through to the deterministic templates below, which use a pure
 * hash rather than the engine RNG so headless replays stay byte-identical.
 */

/**
 * Console ids that ask for a written log entry instead of a silent wait.
 *
 * The set is chosen so that every AI crewmate's *first* assigned console is one
 * of them: the log therefore fills in the opening minute of every match rather
 * than depending on a late-game patrol, and the audience has something written
 * by the agents to read almost immediately.
 */
const LOG_BRIEFS: Record<string, { brief: string; offline: string[] }> = {
  task_cafeteria: {
    brief: "a one-line note on emptying the cafeteria garbage",
    offline: [
      "{name} bagged the trash and left the tray nobody claimed.",
      "{name}: three cups, two trays, one crew manifest with a corner torn off.",
      "Garbage emptied. {name} counted the cups and found one too few.",
      "{name} took the trash out and did not look in the bag first.",
    ],
  },
  task_weapons: {
    brief: "a one-line note on the asteroid you just cleared",
    offline: [
      "{name} broke the rock and swept the fragments before anyone counted them.",
      "{name}: the asteroid is clear, the targeting trace is not.",
      "Weapons clear. {name} logs a clean shot and a second one nobody ordered.",
      "{name} fired once, hit once, and left the log deliberately short.",
    ],
  },
  task_medbay: {
    brief: "a one-line readout of the medical scan you just ran on a crewmate",
    offline: [
      "{name}: scan clean, pulse steady, conscience unreadable.",
      "{name} logged a clean scan and noted the subject avoided eye contact.",
      "MedBay scan complete. {name} flags nothing, but files the hesitation.",
      "{name}: vitals nominal. Recommend nobody needs a bed tonight.",
    ],
  },
  task_reactor: {
    brief: "a one-line note on starting the reactor",
    offline: [
      "{name} brought Reactor up and logged the vibration as normal.",
      "{name}: core stable. One hand scanner read warmer than the other.",
      "Reactor started. {name} notes the coolant hum was not there yesterday.",
      "{name} logged a clean start and stopped writing before the numbers did.",
    ],
  },
  task_security: {
    brief: "a one-line note on the wiring you just fixed",
    offline: [
      "{name} closed the circuit and taped over the spare conductor.",
      "{name}: wiring fixed. Two of the four channels were already cut.",
      "Security wiring restored. {name} declines to say who had been at the panel.",
      "{name} fixed the trace and logged that it had been opened recently.",
    ],
  },
  task_admin: {
    brief: "a one-line note on the ID card you just swiped",
    offline: [
      "{name} swiped the card and the system asked whose it was.",
      "{name}: the card cleared, which is the interesting part.",
      "Admin log: {name} processed a badge issued to nobody on the roster.",
      "{name} swiped, waited, and entered the answer as ‘crew’.",
    ],
  },
  task_o2: {
    brief: "a one-line note on what you found when you cleared the O2 filter",
    offline: [
      "{name} cleared the filter: mostly dust, one button, no owner.",
      "{name}: the O2 filter was clogged with something that had pockets.",
      "Filter clear. {name} declines to describe the smell in writing.",
      "{name} logged the blockage and quietly disposed of the evidence.",
    ],
  },
  task_hallway: {
    brief: "a one-line note on the vent you just cleaned",
    offline: [
      "{name} cleaned the vent and found the grate loosened from the inside.",
      "{name}: duct clear. There were no fasteners left on the cover.",
      "Vent cleaned. {name} logs the scratches and does not speculate.",
      "{name} swept the duct and left the grate exactly as found.",
    ],
  },
  task_storage: {
    brief: "a one-line note on what was in the cargo you were fuelling",
    offline: [
      "{name} topped the tanks and counted the crates twice.",
      "{name}: the manifest lists one crate more than the hold contains.",
      "Fuel load complete. {name} notes the hold was ransacked and re-stacked.",
      "{name} logged a full tank and a short inventory.",
    ],
  },
  task_communications: {
    brief: "a one-line summary of the transmission you just intercepted",
    offline: [
      "{name} logged an intercept nobody will admit to sending.",
      "{name}: the signal repeats four words and then goes quiet.",
      "Comms logged a burst of static shaped exactly like a sentence.",
      "{name} filed the intercept under noise as a courtesy to the crew.",
    ],
  },
  task_shields: {
    brief: "a one-line note on bringing the shields up",
    offline: [
      "{name} raised the shields and logged the draw as within tolerance.",
      "{name}: shields up. The port array answered a fraction late.",
      "Shields primed. {name} notes one emitter had been manually cycled.",
      "{name} brought the array online and left the diagnostics where they fell.",
    ],
  },
};

/**
 * Entries the station log will hold for one match. Above the number of
 * generative consoles, so the whole log survives a full match rather than
 * evicting its own opening.
 */
export const LOG_ENTRY_MAX = 12;
/**
 * Extra model calls a single match may spend on log entries, on top of the
 * movement/dialogue budget. Four busy consoles produce a readable log without
 * meaningfully moving a key's spend.
 */
export const LOG_MODEL_CALLS_MAX = 4;

export interface LogBrief {
  poiId: string;
  brief: string;
  offline: string[];
}

/** The brief for a console, or null when it is ordinary timed busywork. */
export function logBriefFor(poiId: string): LogBrief | null {
  const found = LOG_BRIEFS[poiId];
  return found ? { poiId, brief: found.brief, offline: found.offline } : null;
}

export function isLogConsole(poiId: string): boolean {
  return poiId in LOG_BRIEFS;
}

/** One entry in the public station log, as the UI and the prompts see it. */
export interface StationLogEntry {
  id: number;
  /** Simulation time in seconds. */
  t: number;
  /** Author actor key. */
  key: string;
  name: string;
  color: string;
  /** The console that produced it. */
  poiId: string;
  label: string;
  room: string;
  /** The written entry itself — the thing worth watching. */
  text: string;
  /** Where the text came from. */
  source: "model" | "template";
  /** True when the author was faking the console rather than doing real work. */
  faked: boolean;
}

/**
 * Deterministic 32-bit hash. Used instead of the engine RNG so generating a log
 * entry never perturbs the simulation's random sequence — replays and the
 * headless fingerprint check stay identical with the feature switched on.
 */
function hash(...parts: (string | number)[]): number {
  let h = 2166136261;
  for (const part of parts) {
    const s = String(part);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x9e3779b9;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Fill a template with the author's name. */
function fill(template: string, name: string): string {
  return template.replace(/\{name\}/g, name);
}

/** The offline entry for a console: deterministic, no network, no RNG. */
export function templateLogEntry(
  brief: LogBrief,
  authorName: string,
  seed: number | string,
): string {
  const idx = hash(brief.poiId, authorName, seed) % brief.offline.length;
  return fill(brief.offline[idx], authorName);
}

/** Prompts for the model path. Short by design — this is one line of flavour. */
export function buildLogPrompt(args: {
  authorName: string;
  brief: string;
  label: string;
  room: string;
  faked: boolean;
  traitor: boolean;
}): { system: string; user: string } {
  const role = args.traitor
    ? [
        "You are the hidden traitor aboard a space station.",
        args.faked
          ? "You just pretended to work a console and the log is public, so you must write a cover story that sounds like honest crew work."
          : "You just worked a console and the log is public; write it so it buys you credibility without revealing anything true.",
        "Never admit anything incriminating, and never mention being a traitor.",
      ]
    : [
        "You are a crew member aboard a space station.",
        "You just finished a console task and its log entry is public.",
      ];

  return {
    system: [
      ...role,
      "Write the entry in the station's voice: terse, dry, faintly ominous.",
      "Exactly one sentence, at most 18 words, no quotation marks, no markdown.",
      'Reply with ONLY JSON: {"entry":"<the one sentence>"}',
    ].join("\n"),
    user: JSON.stringify({
      you: args.authorName,
      console: args.label,
      where: args.room,
      write: args.brief,
    }),
  };
}

/** Pull the entry out of a model reply, trimming anything unusable. */
export function parseLogEntry(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as { entry?: unknown };
      if (typeof parsed.entry === "string") {
        const line = parsed.entry.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
        if (line.length > 0) return line.slice(0, 180);
      }
    } catch {
      // fall through to the plain-prose path
    }
  }
  // Some models answer with prose despite JSON mode: take the first sentence.
  const line = text.trim().split(/\n/)[0].trim();
  if (line.length === 0 || line.length > 240) return null;
  return line.slice(0, 180);
}
