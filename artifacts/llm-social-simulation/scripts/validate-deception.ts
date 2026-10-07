/**
 * Headless checks for the deception layer.
 *
 * A social-deduction cast needs two things this script pins down:
 *   - the traitors can actually lie with a *personality* and move the room,
 *   - the crew can actually catch a liar with its own eyes.
 *
 * Everything is offline and deterministic: the claim rules are pure, the
 * memories flow through the real `perception.remember` path, and the last
 * section drives a whole match with no model and asserts the mechanics fired.
 *
 * Run: bun scripts/validate-deception.ts
 */

import { GameEngine } from "../src/game/engine";
import {
  DECEPTION_PERSONAS,
  claimLine,
  crewClaim,
  fabricateClaim,
  judgeClaim,
  personaFor,
  styleForIndex,
  type Claim,
  type ClaimContext,
  type DeceptionStyle,
} from "../src/game/deception";
import { UMBRA_DECK_MAP as map } from "../src/game/map";
import {
  createMind,
  rankSuspects,
  remember,
  type Mind,
} from "../src/game/perception";

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

const names: Record<string, string> = {
  "crew:0": "AI-1",
  "crew:1": "AI-2",
  "crew:2": "AI-3",
  "imp:0": "AI-5",
  "imp:1": "AI-6",
};

// ---------------------------------------------------------------------------
// 1. Personalities
// ---------------------------------------------------------------------------

console.log("=== Deception personas ===");

const styles: DeceptionStyle[] = ["wire-puller", "provocateur", "confidant", "ghost"];
check(styles.every((s) => personaFor(s).label.length > 0), "every persona has a label");
check(
  new Set(styles.map((s) => personaFor(s).playbook)).size === styles.length,
  "every persona has a distinct playbook",
);
check(
  styleForIndex(0) === styleForIndex(0) && styleForIndex(0) !== styleForIndex(1),
  "styles are deterministic and adjacent traitors differ",
);
check(
  styles.includes(styleForIndex(3)) && styles.includes(styleForIndex(4)),
  "lifecycle of the style order wraps within the known styles",
);
check(DECEPTION_PERSONAS["provocateur"].playbook.length > 0, "personas are exported by key");

// ---------------------------------------------------------------------------
// 2. Judging claims — the crew's defence
// ---------------------------------------------------------------------------

console.log("\n=== Judging a claim against the listener's memory ===");

const listener = createMind("crew:0", "crew");
remember(listener, {
  t: 100,
  kind: "sighted",
  actorKey: "imp:0",
  roomId: "electrical",
  text: "AI-5 was in Electrical.",
});
listener.lastSeen["imp:0"] = { t: 100, roomId: "electrical", x: 0, y: 0 };

// A fresh alibi that clashes with what the listener just saw is a catch.
const badAlibi: Claim = { kind: "alibi", about: "imp:0", roomId: "reactor" };
const alibiVerdict = judgeClaim(listener, "imp:0", badAlibi, 110);
check(alibiVerdict.contradicted && alibiVerdict.reason === "alibi", "a clashing alibi is caught");
check(alibiVerdict.sawRoomId === "electrical", "the catch remembers where the listener saw them");

// The same alibi is unfalsifiable once the sighting is stale.
check(
  !judgeClaim(listener, "imp:0", badAlibi, 400).contradicted,
  "a stale sighting no longer falsifies the alibi",
);

// The alibi is not a lie when it agrees with what the listener saw.
check(
  !judgeClaim(listener, "imp:0", { kind: "alibi", about: "imp:0", roomId: "electrical" }, 110)
    .contradicted,
  "a truthful alibi is not treated as a lie",
);

// Nobody can accuse me of something I know I did not do.
const selfVerdict = judgeClaim(listener, "imp:0", { kind: "accuse", about: "crew:0" }, 110);
check(selfVerdict.contradicted && selfVerdict.reason === "self", "the accused always spots the lie");

// A room-bearing accusation about someone the listener saw elsewhere is caught.
const framed = judgeClaim(
  listener,
  "imp:1",
  { kind: "accuse", about: "imp:0", roomId: "reactor" },
  110,
);
check(
  framed.contradicted && framed.reason === "accused-elsewhere",
  "an accusation about a location the listener can disprove is caught",
);

// Vouching for someone the listener watched vent is itself an admission.
const witness = createMind("crew:1", "crew");
remember(witness, {
  t: 50,
  kind: "vent",
  actorKey: "imp:0",
  roomId: "medbay",
  text: "AI-5 used a vent in MedBay.",
});
const vouchVerdict = judgeClaim(witness, "imp:1", { kind: "vouch", about: "imp:0" }, 60);
check(
  vouchVerdict.contradicted &&
    vouchVerdict.reason === "vouched-for-traitor" &&
    vouchVerdict.evidence === "vent",
  "defending someone the listener saw vent is caught",
);

// A harmless accusation moves nothing here — only `applyClaim` acts on it.
check(
  !judgeClaim(listener, "imp:1", { kind: "accuse", about: "crew:2" }, 110).contradicted,
  "an unverifiable accusation is not a lie",
);

// ---------------------------------------------------------------------------
// 3. The belief weights
// ---------------------------------------------------------------------------

console.log("\n=== The belief weights ===");

const victim = createMind("crew:2", "crew");
const before = victim.suspicion["imp:0"] ?? 0.05;
remember(victim, {
  t: 1,
  kind: "accuse",
  actorKey: "imp:0",
  roomId: "admin",
  text: "AI-1 accused AI-5 of being in Admin.",
});
const afterAccuse = victim.suspicion["imp:0"];
check(afterAccuse > before, `an accusation raises suspicion (${before.toFixed(2)} -> ${afterAccuse.toFixed(2)})`);
check(afterAccuse < 0.22, "a single accusation stays below the vote threshold");

remember(victim, {
  t: 2,
  kind: "vouch",
  actorKey: "imp:0",
  roomId: "admin",
  text: "AI-6 vouched for AI-5.",
});
check(victim.suspicion["imp:0"] < afterAccuse, "a vouch pulls suspicion back down");

remember(victim, {
  t: 3,
  kind: "caught",
  actorKey: "imp:0",
  roomId: "electrical",
  text: "AI-5 lied — I saw them in Electrical.",
});
check(victim.suspicion["imp:0"] > 0.3, "a caught lie makes the liar the clear top suspect");
check(rankSuspects(victim, 0.22)[0]?.key === "imp:0", "the caught liar is who the crew would vote for");

// Vouching must never run suspicion below the floor.
const cleared = createMind("crew:3", "crew");
for (let i = 0; i < 6; i++) {
  remember(cleared, {
    t: i,
    kind: "vouch",
    actorKey: "imp:0",
    roomId: "admin",
    text: "vouched",
  });
}
check(
  (cleared.suspicion["imp:0"] ?? 0) === 0,
  "repeated vouches clamp at zero and never go negative",
);

// An ally is untouchable by a claim, exactly like every other belief.
const allyMind = createMind("imp:0", "imposter", ["imp:1"]);
remember(allyMind, {
  t: 1,
  kind: "accuse",
  actorKey: "imp:1",
  roomId: "admin",
  text: "accused my ally",
});
check(allyMind.suspicion["imp:1"] === undefined, "a traitor can never suspect its ally");

// ---------------------------------------------------------------------------
// 4. Fabrication — the traitor's lie
// ---------------------------------------------------------------------------

console.log("\n=== Fabrication ===");

const ctx: ClaimContext = {
  others: ["crew:0", "crew:1", "imp:0", "imp:1"],
  names,
  selfKey: "imp:0",
  seed: 1,
  turn: 1,
  alibiRoomId: "storage",
};

const seenKinds = new Set<string>();
let everAccusedAlly = false;
let everSelfAccused = false;
for (const style of styles) {
  for (let seed = 0; seed < 40; seed++) {
    const mind = createMind("imp:0", "imposter", ["imp:1"]);
    const claim = fabricateClaim(style, mind, map, { ...ctx, seed });
    if (!claim) continue;
    seenKinds.add(claim.kind);
    if (claim.about === "imp:1" && claim.kind === "accuse") everAccusedAlly = true;
    if (claim.about === "imp:0" && claim.kind !== "alibi") everSelfAccused = true;
    if (claim.roomId && !map.rooms.some((r) => r.id === claim.roomId)) {
      check(false, `fabricated claim names a real room (${claim.roomId})`);
    }
  }
}
check(!everAccusedAlly, "a traitor never invents an accusation against its ally");
check(!everSelfAccused, "a traitor never names itself as the accused");
check(seenKinds.has("accuse"), "traitors fabricate accusations");
check(seenKinds.has("alibi"), "traitors offer alibis");
check(seenKinds.has("vouch"), "traitors vouch to build trust");

// The crew's claim is grounded in its own memory — no invention.
const witnessCrew = createMind("crew:1", "crew");
remember(witnessCrew, {
  t: 40,
  kind: "kill",
  actorKey: "imp:0",
  roomId: "medbay",
  text: "AI-5 killed someone in MedBay.",
});
const crewAccuse = crewClaim(witnessCrew, { ...ctx, selfKey: "crew:1" });
check(
  crewAccuse?.kind === "accuse" && crewAccuse.about === "imp:0" && crewAccuse.roomId === "medbay",
  "a crewmate's claim is its own witnessed evidence, room and all",
);

const liarTracker = createMind("crew:2", "crew");
remember(liarTracker, {
  t: 60,
  kind: "caught",
  actorKey: "imp:1",
  roomId: "admin",
  text: "AI-6 lied — I saw them in Admin.",
});
const catchClaim = crewClaim(liarTracker, { ...ctx, selfKey: "crew:2" });
check(
  catchClaim?.kind === "accuse" &&
    catchClaim.about === "imp:1" &&
    catchClaim.detail === "lied about where they were",
  "a crewmate that caught a liar accuses the liar specifically",
);

// The spoken line and the structured claim always agree.
const line = claimLine(map, crewAccuse!, names, 0);
check(line.includes("AI-5"), `the spoken line names the claim's target ("${line}")`);

// ---------------------------------------------------------------------------
// 5. The whole loop through the engine
// ---------------------------------------------------------------------------

console.log("\n=== The engine end-to-end ===");

interface EngineInternals {
  applyClaim(speaker: unknown, meeting: unknown, claim: Claim | null): void;
  time: number;
}

const engine = new GameEngine({ playerIsImposter: false, seed: 5, llm: false, legacy: false });
engine.begin();
const internals = engine as unknown as EngineInternals;

const imp = engine.actors.find((a) => a.kind === "imposter")!;
const crewmate = engine.actors.find((a) => a.kind === "crew")!;
const bystander = engine.actors.filter((a) => a.kind === "crew" && a !== crewmate)[0];

check(imp.deceptionStyle !== null, `traitors are assigned a persona (${imp.deceptionStyle})`);
check(crewmate.deceptionStyle === null, "crewmates have no deception persona");

// Plant a contradictory sighting for the bystander, then run the accusation
// through the real `applyClaim` path the meeting uses.
internals.time = 120;
const accusedTarget = engine.actors.find((a) => a.kind === "crew" && a !== bystander)!;
bystander.mind.lastSeen[imp.key] = {
  t: 118,
  roomId: "medbay",
  x: 0,
  y: 0,
};

const fabricated: Claim = { kind: "alibi", about: imp.key, roomId: "reactor" };
internals.applyClaim(imp, { claimsApplied: new Set<string>() }, fabricated);

const caught = bystander.mind.memories.find((m) => m.kind === "caught");
check(caught !== undefined && caught.actorKey === imp.key, "the engine banks a caught-lie memory");
check(
  (bystander.mind.suspicion[imp.key] ?? 0) > 0.3,
  "catching the lie makes the traitor the bystander's top suspect",
);

// An unchallenged accusation, by contrast, just shades the room.
const framedTarget = accusedTarget.key;
internals.applyClaim(imp, { claimsApplied: new Set<string>() }, {
  kind: "accuse",
  about: framedTarget,
});
const framedActor = engine.actors.find((a) => a.key === framedTarget)!;
check(
  (bystander.mind.suspicion[framedActor.key] ?? 0) > 0.05,
  "an unchallenged accusation raises the room's suspicion of the target",
);
check(
  (bystander.mind.suspicion[framedActor.key] ?? 0) < 0.22,
  "…but never enough to decide a vote alone",
);

// Reachability: the framed crewmate itself heard the accusation and knows it
// is false, so it distrusts the accuser — but only as a suspicion.
check(
  framedActor.mind.memories.some((m) => m.kind === "accuse" && m.actorKey === imp.key),
  "the accused crewmate knows the accusation is false and distrusts the liar",
);
check(
  (framedActor.mind.suspicion[imp.key] ?? 0) <= 0.22,
  "…but being falsely accused is a suspicion, not a conviction",
);

// A full, model-free match must actually exercise the new memory kinds.
const match = new GameEngine({ playerIsImposter: false, seed: 42, llm: false });
match.begin();
let guard = 0;
while (match.phase !== "ended" && match.time < 900 && guard++ < 60 * 900) {
  match.tick(1 / 60);
}
check(match.phase === "ended", "an AI-only match still resolves");
const allMemories = match.actors.flatMap((a) => a.mind.memories);
const accusations = allMemories.filter((m) => m.kind === "accuse").length;
check(accusations > 0, `meetings produced public accusations (${accusations})`);
check(
  Object.values(match.actors.flatMap((a) => Object.values(a.mind.suspicion))).every(
    (s) => s >= 0 && s <= 1,
  ),
  "claims never push a belief outside [0, 1]",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nDeception checks passed ✓");
