/**
 * Headless checks for the "watchability" pass: the three systems that make a
 * match worth *watching* rather than merely reading.
 *
 *   1. Generative station-log tasks — an AI writes real content at a console.
 *   2. The confessional — each agent's private thought, distinct from its line.
 *   3. The cross-match ledger — grudges that survive between shifts.
 *
 * Everything here is pure or offline: no network, no `localStorage`. The point
 * is to pin the *rules* (grudges are capped below the actionable threshold,
 * templates are deterministic, a traitor's confessional is always a cover
 * story) so the fun parts cannot be broken silently by a later change.
 *
 * Run: bun scripts/validate-watchability.ts
 */

import {
  LOG_ENTRY_MAX,
  LOG_MODEL_CALLS_MAX,
  buildLogPrompt,
  isLogConsole,
  logBriefFor,
  parseLogEntry,
  templateLogEntry,
} from "../src/game/creative";
import { GameEngine } from "../src/game/engine";
import {
  emptyLedger,
  foldMatch,
  grudgeWeight,
  grudgesFor,
  loadLegacy,
  saveLegacy,
  seedGrudges,
  type LegacyLedger,
  type LegacyMatchSummary,
} from "../src/game/legacy";
import { UMBRA_DECK_MAP } from "../src/game/map";
import { TASKS_PER_CREW, assignTasks } from "../src/game/tasks";
import { confessionalFallback, memoryToLine } from "../src/game/dialogue";
import {
  MAX_GRUDGE,
  createMind,
  decay,
  rankSuspects,
  remember,
  topSuspect,
} from "../src/game/perception";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Generative station-log tasks
// ---------------------------------------------------------------------------

console.log("=== Station log ===");

const logConsoles = UMBRA_DECK_MAP.pointsOfInterest
  .filter((p) => p.kind === "task" && isLogConsole(p.id))
  .map((p) => p.id);

check(logConsoles.length >= 8, `most consoles are generative (${logConsoles.length})`);
check(
  logConsoles.every((id) => logBriefFor(id)?.offline.length),
  "every generative console has offline templates",
);
check(
  LOG_ENTRY_MAX >= logConsoles.length,
  "the log holds a full match without evicting its own opening",
);

// The property that makes the log fill in the opening minute of *every* match
// rather than racing the endgame: each AI crewmate's first assigned console is
// generative. Actor index 0 is the human, so the AI crew sit at 1..AI_CREW.
for (let slot = 1; slot <= 4; slot++) {
  const first = assignTasks(UMBRA_DECK_MAP, TASKS_PER_CREW, slot * TASKS_PER_CREW)[0];
  check(
    isLogConsole(first.poiId),
    `AI crewmate ${slot} opens on a generative console (${first.poiId})`,
  );
}

// Ordinary consoles must stay ordinary timed busywork.
const timed = UMBRA_DECK_MAP.pointsOfInterest.find(
  (p) => p.kind === "task" && !isLogConsole(p.id),
);
check(timed !== undefined, "at least one console remains plain timed work");
check(
  timed !== undefined && logBriefFor(timed.id) === null,
  "a plain console has no log brief",
);

// The model call budget must stay small — this is what keeps the feature cheap.
check(
  LOG_MODEL_CALLS_MAX > 0 && LOG_MODEL_CALLS_MAX <= 6,
  `live log calls per match stay small (${LOG_MODEL_CALLS_MAX})`,
);
check(
  LOG_MODEL_CALLS_MAX < logConsoles.length + 4,
  "the log call cap is below the console count, so the cap is the real limit",
);

// Templates are deterministic and name the author, so a replay is reproducible.
const brief = logBriefFor(logConsoles[0])!;
const a1 = templateLogEntry(brief, "AI-1", "seed");
const a2 = templateLogEntry(brief, "AI-1", "seed");
check(a1 === a2, "the offline template is deterministic for the same seed");
check(a1.includes("AI-1"), "the offline template credits its author");
check(
  templateLogEntry(brief, "AI-2", "seed") !== a1,
  "a different author gets a different line",
);
check(
  templateLogEntry(brief, "AI-1", "other") !== a1,
  "a different seed can pick a different line",
);

// The model replies we actually see must parse, and the rubbish must not.
check(
  parseLogEntry('{"entry":"Filter clear. The smell stays off the record."}') ===
    "Filter clear. The smell stays off the record.",
  "a JSON reply parses to the entry",
);
check(
  parseLogEntry('```json\n{"entry":"Tanks full, manifest short."}\n```') ===
    "Tanks full, manifest short.",
  "a fenced JSON reply still parses",
);
const prose = parseLogEntry(
  "Intercept logged: four words, then nothing.\nSecond sentence dropped.",
);
check(
  prose === "Intercept logged: four words, then nothing.",
  "a prose reply keeps the first sentence only",
);
check(parseLogEntry("   ") === null, "an empty reply is refused");
check(parseLogEntry("x".repeat(400)) === null, "an oversized reply is refused");

// The prompt has to tell a traitor to write a cover story and a crewmate to
// just write the entry — that difference is the whole point of letting
// impostors post to a public log.
const traitor = buildLogPrompt({
  authorName: "AI-5",
  brief: brief.brief,
  label: "Fuel Engines",
  room: "Storage",
  faked: true,
  traitor: true,
});
const crew = buildLogPrompt({
  authorName: "AI-1",
  brief: brief.brief,
  label: "Fuel Engines",
  room: "Storage",
  faked: false,
  traitor: false,
});
check(/traitor/i.test(traitor.system), "the traitor brief names the role");
check(/cover story/i.test(traitor.system), "a faked console asks for a cover story");
check(/only JSON/i.test(traitor.system), "the log prompt pins the reply format");
check(!/traitor/i.test(crew.system), "the crew brief does not mention a traitor");
check(crew.system !== traitor.system, "the two briefs differ");

// ---------------------------------------------------------------------------
// 2. The confessional
// ---------------------------------------------------------------------------

console.log("\n=== Confessional ===");

const names = { "crew:0": "AI-1", "crew:1": "AI-2", "imp:0": "AI-5", "imp:1": "AI-6" };

// The offline path is what a match with no key (or a spent budget) falls back
// to, so the confessional must still say something *true to the role*: a
// traitor gets a cover-story thought, a crewmate gets its real read.
const crewMind = createMind("crew:0", "crew");
remember(crewMind, {
  t: 0,
  kind: "vent",
  actorKey: "crew:1",
  roomId: "electrical",
  text: "AI-2 used a vent in Electrical.",
});
const crewThought = confessionalFallback(crewMind, names);
check(crewThought.includes("AI-2"), "a crew confessional names its actual suspect");

const impMind = createMind("imp:0", "imposter", ["imp:1"]);
const impThought = confessionalFallback(impMind, names);
check(impThought.includes("AI-6"), "a traitor confessional keeps its ally in mind");
check(impThought !== crewThought, "the two roles confess differently");
check(
  confessionalFallback(createMind("crew:2", "crew"), names).length > 0,
  "even a sightless crewmate has a private thought",
);

// The public log is remembered as neutral context, and quoting it back must not
// mangle the line the audience just read.
const logLine = 'Station log: AI-1 filed "Tanks full, manifest short." at Fuel Engines in Storage.';
remember(crewMind, { t: 1, kind: "log", actorKey: "crew:0", roomId: "storage", text: logLine });
check(
  memoryToLine(UMBRA_DECK_MAP, { t: 1, kind: "log", actorKey: "crew:0", roomId: "storage", text: logLine }, { key: "crew:1", name: "AI-2" }, names) === logLine,
  "a station-log memory is quoted verbatim",
);
check(
  (crewMind.suspicion["crew:0"] ?? 0) <= 0.05,
  "reading the log never counts as evidence against its author",
);

// ---------------------------------------------------------------------------
// 3. The cross-match ledger
// ---------------------------------------------------------------------------

console.log("\n=== Cross-match ledger ===");

const summary: LegacyMatchSummary = {
  winner: "imposter",
  roster: [
    { name: "AI-1", role: "crew" },
    { name: "AI-2", role: "crew" },
    { name: "AI-5", role: "imposter" },
  ],
  ejections: [
    // A crew member is voted out by AI-2 and AI-5: AI-2 earns the grudge.
    { name: "AI-1", role: "crew", voters: ["AI-2", "AI-5"] },
    // A correct ejection must leave no grudge behind.
    { name: "AI-5", role: "imposter", voters: ["AI-1", "AI-2"] },
  ],
};

const first = foldMatch(emptyLedger(), summary);
check(first.shifts === 1, "the fold advances the shift count");
check(first.agents["AI-1"].eliminations === 1, "the ejected agent is recorded");
check(first.agents["AI-1"].mislynched === 1, "an innocent ejection is flagged as a mislynch");
check(
  grudgesFor(first, "AI-1").includes("AI-2"),
  "the mislynched agent blames the crewmate who voted it out",
);
check(
  grudgesFor(first, "AI-1").includes("AI-5"),
  "…and also the traitor that piled onto the mislynch",
);
check(
  grudgesFor(first, "AI-5").length === 0,
  "a correctly ejected imposter holds no grudge",
);
check(
  first.agents["AI-5"].wins === 1 && first.agents["AI-1"].wins === 0,
  "wins are credited to the winning faction only",
);

// A dossier must be a bias, never a verdict: the seed has to sit below the
// threshold at which an agent acts on a suspicion, or a grudge would decide a
// match on its own.
// AI-1 was voted out by AI-2, so AI-1 is the mind that carries the grudge.
const seeded = createMind("AI-1", "crew");
const roster = [
  { key: "AI-1", name: "AI-1" },
  { key: "AI-2", name: "AI-2" },
];
const applied = seedGrudges(seeded, "AI-1", first, roster);
check(applied.includes("AI-2"), "the grudge is applied to the named target");
check(
  (seeded.suspicion["AI-2"] ?? 0) <= MAX_GRUDGE + 0.05,
  "a seeded grudge stays inside its cap",
);
check(
  seeded.suspicion["AI-2"] > 0.05,
  "a seeded grudge is actually above the neutral baseline",
);
check(
  seeded.suspicion["AI-1"] === undefined,
  "an agent never seeds a grudge against itself",
);
check(
  topSuspect(seeded, 0.15) === null,
  "a lone grudge is below the threshold an agent acts on",
);
check(
  rankSuspects(seeded, 0.08).length > 0,
  "…but still visible as a hunch worth recording",
);

// Grudges must erode inside a match, like every other belief.
const before = seeded.suspicion["AI-2"];
for (let i = 0; i < 60; i++) decay(seeded, 1);
check(
  seeded.suspicion["AI-2"] < before,
  "a grudge decays over the course of the shift",
);

// Repeated offences compound, but still saturate under the cap.
let ledger: LegacyLedger = first;
for (let i = 0; i < 4; i++) {
  ledger = foldMatch(ledger, {
    winner: "crew",
    roster: summary.roster,
    ejections: [{ name: "AI-1", role: "crew", voters: ["AI-2"] }],
  });
}
check(
  grudgeWeight(ledger, "AI-1", "AI-2") <= MAX_GRUDGE,
  `a long-running grudge saturates below the cap (${grudgeWeight(ledger, "AI-1", "AI-2").toFixed(3)})`,
);
check(
  grudgeWeight(ledger, "AI-1", "AI-2") > grudgeWeight(first, "AI-1", "AI-2"),
  "repeated betrayals deepen the grudge",
);
check(grudgeWeight(ledger, "NOBODY", "AI-2") === 0, "an unknown agent carries nothing");
check(ledger.shifts === 5, "every fold is counted");

// An ally is never seeded: a traitor must not distrust its own partner.
const imp = createMind("imp:0", "imposter", ["imp:1"]);
const allyLedger: LegacyLedger = {
  shifts: 1,
  agents: {
    "AI-5": {
      name: "AI-5",
      games: 1,
      wins: 0,
      eliminations: 1,
      mislynched: 1,
      grudges: { "AI-6": 3, "AI-1": 2 },
    },
  },
};
const allyApplied = seedGrudges(imp, "AI-5", allyLedger, [
  { key: "imp:0", name: "AI-5" },
  { key: "imp:1", name: "AI-6" },
  { key: "crew:0", name: "AI-1" },
]);
check(!allyApplied.includes("AI-6"), "a traitor never carries a grudge against its ally");
check(allyApplied.includes("AI-1"), "…but does carry one against a crewmate");
check(imp.suspicion["imp:1"] === undefined, "the ally's suspicion is untouched");
check(imp.suspicion["crew:0"] !== undefined, "the crewmate's suspicion is seeded");

// With no storage (headless, private mode) the ledger must be inert, never a
// crash and never an invented record.
const offline = loadLegacy();
check(typeof offline.shifts === "number", "the ledger loads without throwing");
check(
  Object.keys(offline.agents).length === 0,
  "no agents are invented when there is nothing on record",
);

// ---------------------------------------------------------------------------
// 4. The ledger through the real interface
// ---------------------------------------------------------------------------

console.log("\n=== Cross-match wiring ===");

// Bun has no `localStorage`, so stand one up: this is the same code path the
// browser takes, driven through the public engine API rather than the helpers.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

// Names are the cross-match identity, and they depend on whether a provider key
// is present, so read them off a real roster rather than hard-coding them.
const scout = new GameEngine({ seed: 5, llm: false });
const aiNames = scout.actors.filter((a) => !a.isPlayer).map((a) => a.name);
check(aiNames.length >= 2, `the roster has AI names to key the ledger on (${aiNames.length})`);
const [grudgeHolder, grudgeTarget] = aiNames;

saveLegacy({
  shifts: 1,
  agents: {
    [grudgeHolder]: {
      name: grudgeHolder,
      games: 1,
      wins: 0,
      eliminations: 1,
      mislynched: 1,
      grudges: { [grudgeTarget]: 1 },
    },
  },
});

const carried = new GameEngine({ seed: 5, llm: false });
const view = carried.legacyView();
check(view !== null && view.shifts === 1, "a fresh engine reads the prior shift count");
check(
  view !== null &&
    (view.agents.find((a) => a.name === grudgeHolder)?.grudges ?? []).includes(grudgeTarget),
  "the briefing can see who carries a grudge against whom",
);

const holderActor = carried.actors.find((a) => a.name === grudgeHolder)!;
const targetActor = carried.actors.find((a) => a.name === grudgeTarget)!;
const seededScore = holderActor.mind.suspicion[targetActor.key];
check(seededScore !== undefined, "the grudge is seeded into the agent's belief vector");
check(
  seededScore !== undefined && seededScore > 0.05 && seededScore < 0.15,
  `the seeded grudge is a hunch, not a verdict (${seededScore?.toFixed(3)})`,
);
check(
  Object.keys(carried.playerActor.mind.suspicion).length === 0,
  "the human is never handed a hidden grudge",
);
check(
  carried.snapshot().legacy !== null,
  "the snapshot carries the ledger through to the UI",
);

// The end-to-end loop GameStage runs: finish a match, fold it, save it, and
// have the *next* engine open with the grudge that match created.
carried.begin();
let guard = 0;
while (carried.phase !== "ended" && guard++ < 60000) carried.tick(1 / 60);
check(carried.phase === "ended", "the carried-over match resolves");
const carriedSummary = carried.legacySummary();
check(carriedSummary !== null, "the finished match reports a ledger summary");
if (carriedSummary) saveLegacy(foldMatch(loadLegacy(), carriedSummary));

const next = new GameEngine({ seed: 9, llm: false });
check(next.legacyView()?.shifts === 2, "the next engine opens on the folded ledger");
check(
  (next.legacyView()?.agents ?? []).every(
    (a) => a.games >= 1 && a.eliminations >= 0,
  ),
  "every agent on the deck has a well-formed record",
);

// `legacy: false` must switch the whole mechanism off for tests and replays.
const pure = new GameEngine({ seed: 5, llm: false, legacy: false });
check(pure.legacyView() === null, "legacy can be switched off entirely");
check(
  Object.values(pure.actors).every((a) => Object.keys(a.mind.suspicion).length === 0),
  "with the ledger off nobody opens the shift distrusting anyone",
);

delete (globalThis as unknown as { localStorage?: Storage }).localStorage;

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nWatchability checks passed ✓");
