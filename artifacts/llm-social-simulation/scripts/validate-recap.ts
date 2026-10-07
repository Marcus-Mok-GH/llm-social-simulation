/**
 * Headless checks for the recap layer: the structured match timeline and the
 * narrative the end screen builds from it.
 *
 * Two halves:
 *   1. The engine actually emits the beats — run real matches with no driver
 *      and assert the timeline carries kills, meetings, ejections and exactly
 *      one terminal verdict, in order, with the right fields.
 *   2. `buildRecap` is pure and rule-driven — synthetic timelines pin the
 *      spotlight priority (a mislynch outranks a clean kill), the lie-vs-read
 *      quote choice, and that the same record always re-narrates identically.
 *
 * Run: bun scripts/validate-recap.ts
 */

import { GameEngine } from "../src/game/engine";
import type { MatchEvent } from "../src/game/events";
import { buildRecap, type RecapInput } from "../src/game/recap";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

/** Run a full match with no human driver; the AI plays itself to the end. */
function run(seed: number): GameEngine {
  const engine = new GameEngine({ playerIsImposter: false, seed, llm: false, legacy: false });
  engine.begin();
  let guard = 0;
  while (engine.phase !== "ended" && guard++ < 120000) engine.tick(1 / 60);
  return engine;
}

// ---------------------------------------------------------------------------
// 1. The engine emits a well-formed timeline
// ---------------------------------------------------------------------------

console.log("=== Engine timeline ===");

const seeds = [42, 777, 1234, 2026, 9];
const runs = seeds.map(run);
const all = runs.flatMap((e) => e.matchEvents());

check(all.length > 0, "a finished match records a timeline");
check(
  runs.every((e) => e.matchEvents().length > 0),
  "every finished match records a timeline",
);

const ends = all.filter((e) => e.kind === "end");
check(ends.length === seeds.length, `each match ends exactly once (${ends.length}/${seeds.length})`);
check(
  runs.every((e) => e.matchEvents().at(-1)?.kind === "end"),
  "the verdict is the last event of every match",
);

const kills = all.filter((e) => e.kind === "kill");
check(kills.length > 0, `the imposters killed (${kills.length} kills across ${seeds.length} matches)`);
check(
  kills.every((k) => k.killerName.length > 0 && k.victimName.length > 0 && k.roomName.length > 0),
  "every kill names a killer, a victim and a room",
);
check(
  kills.every((k) => typeof k.witnessed === "boolean"),
  "every kill records whether it was seen",
);
check(
  kills.every((k) => k.killerName !== k.victimName),
  "an imposter never kills itself",
);

const meetings = all.filter((e) => e.kind === "meeting");
check(meetings.length > 0, `meetings were called (${meetings.length})`);
check(
  meetings.every((m) => (m.reason === "report" || m.reason === "emergency") && m.byName.length > 0),
  "every meeting names its reason and caller",
);

const ejects = all.filter((e) => e.kind === "eject");
check(
  ejects.every((e) => (e.role === "crew" || e.role === "imposter") && typeof e.name === "string"),
  "every ejection carries the ejected agent's true role",
);
check(
  ejects.every((e) => Array.isArray(e.voters) && !e.voters.includes(e.name)),
  "an ejected agent is never listed among its own voters",
);

// Time must never run backwards on the timeline.
check(
  runs.every((e) => {
    const ts = e.matchEvents().map((x) => x.t);
    return ts.every((t, i) => i === 0 || t >= ts[i - 1]);
  }),
  "timeline events are in non-decreasing time order",
);

// ---------------------------------------------------------------------------
// 2. The recap is pure and rule-driven
// ---------------------------------------------------------------------------

console.log("\n=== Recap ===");

const baseEvents: MatchEvent[] = [
  {
    kind: "kill",
    t: 20,
    killerKey: "imp:0",
    killerName: "AI-5",
    victimKey: "crew:0",
    victimName: "AI-1",
    roomName: "Electrical",
    witnessed: false,
  },
  {
    kind: "meeting",
    t: 40,
    reason: "report",
    byKey: "crew:1",
    byName: "AI-2",
  },
  {
    kind: "eject",
    t: 60,
    key: "crew:2",
    name: "AI-3",
    role: "crew",
    voters: ["AI-2", "AI-5"],
  },
  { kind: "end", t: 120, winner: "imposter", reason: "The imposters outnumber the crew. Imposters win." },
];

const input: RecapInput = {
  winner: "imposter",
  durationSec: 125,
  roster: [
    { key: "crew:0", name: "AI-1", role: "crew", alive: false },
    { key: "crew:2", name: "AI-3", role: "crew", alive: false },
    { key: "imp:0", name: "AI-5", role: "imposter", alive: true },
  ],
  events: baseEvents,
  confessional: [
    { t: 21, name: "AI-5", role: "imposter", action: "killed AI-1", thought: "Nobody was watching. I'll walk the other way." },
    { t: 50, name: "AI-2", role: "crew", action: "accused AI-3", thought: "AI-3 is too quiet. Voting them." },
  ],
};

const recap = buildRecap(input);
check(recap !== null, "a timeline produces a recap");
if (recap) {
  check(recap.title.includes("Imposter victory") && recap.title.includes("2:05"), `the title states the verdict and clock (${recap.title})`);
  check(recap.beats.length === baseEvents.length, "one beat per timeline event");
  check(recap.stats.kills === 1 && recap.stats.silentKills === 1, "kills are counted, silent ones flagged");
  check(recap.stats.mislynches === 1 && recap.stats.caught === 0, "a crew ejection counts as a mislynch");
  check(recap.spotlight?.label === "THE MISLYNCH", "a mislynch outranks the kill for the spotlight");
  check(
    recap.spotlight?.text.includes("AI-3") === true,
    "the spotlight names the agent who was mislynched",
  );
  check(recap.quote?.concealing === true && recap.quote.name === "AI-5", "the closing quote prefers a surviving liar");
  check(recap.beats.at(-1)?.kind === "verdict", "the recap closes on the verdict");
}

// Without a mislynch, the clean kill takes the spotlight.
const cleanSpot = buildRecap({
  ...input,
  winner: "crew",
  events: baseEvents.filter((e) => e.kind !== "eject"),
}).spotlight;
check(cleanSpot?.label === "THE CLEAN KILL", "with no mislynch, the silent kill is the spotlight");

// Determinism: same input, same recap.
const again = buildRecap(input);
check(JSON.stringify(recap) === JSON.stringify(again), "the recap is deterministic for the same record");

// A record with no timeline degrades to no recap rather than an empty shell.
check(buildRecap({ ...input, events: [] }) === null, "a record with no timeline yields no recap");
check(buildRecap({ ...input, events: undefined }) === null, "an old record without events yields no recap");

// A witnessed kill, with nothing else, still produces a spotlight.
const slip = buildRecap({
  winner: "crew",
  durationSec: 30,
  roster: [{ key: "imp:0", name: "AI-5", role: "imposter", alive: false }],
  events: [
    { kind: "kill", t: 5, killerKey: "imp:0", killerName: "AI-5", victimKey: "crew:0", victimName: "AI-1", roomName: "Storage", witnessed: true },
    { kind: "end", t: 30, winner: "crew", reason: "Every imposter has been ejected. Crew win." },
  ],
}).spotlight;
check(slip?.label === "THE SLIP", "a witnessed kill alone becomes the slip");

// The quote falls back to a crew read when no liar is present.
const crewQuote = buildRecap({
  ...input,
  winner: "crew",
  confessional: [{ t: 50, name: "AI-2", role: "crew", action: "voted", thought: "The vents told me everything." }],
}).quote;
check(crewQuote?.concealing === false && crewQuote.role === "crew", "with no liar, the quote is a crew read");

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nRecap checks passed ✓");
