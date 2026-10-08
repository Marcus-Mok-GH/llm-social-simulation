/**
 * Live model check.
 *
 * Exercises the *real* network path the game uses: `readLlmConfig()` reads the
 * key from the environment, then every model entry point the engine calls is
 * exercised against it — a movement intent, a meeting line, and a station-log
 * entry — and each is validated exactly as the engine validates it. A pass here
 * means agent reasoning works against the configured endpoint rather than only
 * the heuristic fallback.
 *
 * Budget: this spends one call per model in the pool, plus six engine calls —
 * two movement intents, two meeting statements and two station-log entries.
 * Everything is paid for out of `ai.budget`, which the run prints at the end.
 *
 * Run: POLLINATIONS_API_KEY=pk_... bun scripts/verify-llm.ts
 *   or: BERGET_API_KEY=sk_ber_... bun scripts/verify-llm.ts
 */

import {
  intentWithModel,
  logEntryWithModel,
  statementWithModel,
  type AiContext,
  type WorldView,
} from "../src/ai/decision";
import { logBriefFor } from "../src/game/creative";
import {
  complete,
  configFor,
  extractJson,
  readLlmConfig,
  readProviders,
  RequestGate,
} from "../src/ai/llm";
import { UMBRA_DECK_MAP } from "../src/game/map";
import { createMind, remember } from "../src/game/perception";

const cfg = readLlmConfig();
if (!cfg) {
  console.error(
    "No API key found (POLLINATIONS_API_KEY, BERGET_API_KEY or the VITE_LLM_* overrides) — cannot verify the model path.",
  );
  process.exit(2);
}

const provider = readProviders()[0];

console.log(`Provider : ${cfg.provider}`);
console.log(`Endpoint : ${cfg.baseUrl}`);
console.log(`Model    : ${cfg.model}`);
console.log(`Pool     : ${provider.models.length} models (one per agent)`);
console.log(`Key      : ${cfg.apiKey.slice(0, 7)}… (${cfg.apiKey.length} chars)`);

const ai: AiContext = { cfg, gate: new RequestGate(0, 2), budget: { remaining: 24 } };

type ZoneRef = WorldView["zones"][number];

const zone = (id: string, name: string, kind: "room" | "corridor", adjacent = false): ZoneRef => ({
  id,
  name,
  kind,
  adjacent,
});

function view(role: "crew" | "imposter"): WorldView {
  const zones: ZoneRef[] = [
    zone("cafeteria", "Cafeteria", "room", true),
    zone("medbay", "MedBay", "room"),
    zone("electrical", "Electrical", "room"),
    zone("navigation", "Navigation", "room"),
    zone("storage", "Storage", "room"),
    zone("c_central_hall", "Central Hall", "corridor", true),
    zone("c_nw_hall", "Northwest Hall", "corridor", true),
  ];
  return {
    self: {
      key: role === "imposter" ? "imp:0" : "crew:0",
      name: role === "imposter" ? "SHADE" : "ROOK",
      role,
      roomId: "cafeteria",
      roomName: "Cafeteria",
      alive: true,
      zoneId: "cafeteria",
      zoneName: "Cafeteria",
    },
    current_location: "Cafeteria",
    current_time: "02:45",
    visible_players: ["VEGA"],
    valid_moves: zones.filter((z) => z.adjacent),
    zones,
    tasks: [
      { poiId: "task_cafeteria", label: "Empty Garbage", roomId: "cafeteria", roomName: "Cafeteria", done: false },
      { poiId: "task_medbay", label: "Submit Scan", roomId: "medbay", roomName: "MedBay", done: true },
    ],
    consoles: [
      { poiId: "task_cafeteria", label: "Empty Garbage", roomId: "cafeteria", roomName: "Cafeteria" },
      { poiId: "task_medbay", label: "Submit Scan", roomId: "medbay", roomName: "MedBay" },
      { poiId: "task_electrical", label: "Calibrate Distributor", roomId: "electrical", roomName: "Electrical" },
    ],
    interactables: [
      { id: "task_cafeteria", type: "TASK", name: "Empty Garbage", status: "incomplete", in_range: true },
    ],
    system_message: null,
    others: [
      // Sight only: VEGA is in the room with the agent. JUNO and VEX are not in
      // the snapshot because the agent cannot see them.
      { key: "crew:1", name: "VEGA", roomId: "cafeteria", roomName: "Cafeteria", zoneId: "cafeteria", zoneName: "Cafeteria", isolation: 420, allied: false },
    ],
    known_allies: role === "imposter" ? ["VEX"] : [],
    last_seen: [
      { key: "crew:2", name: "JUNO", zoneId: "medbay", zoneName: "MedBay", ago: 25 },
    ],
    history: [
      "[00:40 sighted] Saw VEGA in Cafeteria not long ago.",
      "[01:20 task] Watched JUNO work a console in MedBay.",
    ],
    your_goal:
      role === "imposter" ? 'Fake work at "Calibrate Distributor" in Electrical (alibi)' : 'Work "Empty Garbage" in Cafeteria',
    goal_since: "02:10",
    last_reasoning: role === "imposter" ? "build an alibi" : "next unfinished task",
    last_action: "Moving to Cafeteria",
    last_move: "Cafeteria",
    decision_history: [
      { at: "01:10", goal: 'Work "Empty Garbage" in Cafeteria', action: "Moving to Cafeteria for \"Empty Garbage\"", reasoning: "next unfinished task" },
      { at: "02:40", goal: 'Work "Empty Garbage" in Cafeteria', action: "Moving to Cafeteria for \"Empty Garbage\"", reasoning: "still the nearest console" },
    ],
    meeting_history: [
      {
        at: "01:30",
        reason: "SHADE reported a body",
        lines: ["SHADE: I found a body in MedBay.", "VEGA: I was on tasks the whole time."],
        ejected: null,
      },
    ],
    // Engine-internal for the heuristic only — `summarise` never sees it, so
    // no suspicion value reaches the model.
    lead: role === "crew" ? "VEGA" : null,
    cooldowns: { kill: role === "imposter" ? 0 : 99 },
    bodyOutstanding: false,
    taskProgress: 0.35,
    // Cross-match context: this agent has played before and walked in already
    // watching VEX. Non-empty on purpose, so the live run exercises the fields.
    shifts_played: 3,
    your_grudges: ["VEX"],
  };
}

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures++;
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

// --- 0. Every model in the pool answers in JSON mode -------------------------
// Each AI agent is bound to a different model, so a pool entry that cannot
// answer would silently strand that agent on the heuristic fallback.
for (const model of provider.models) {
  const text = await complete(
    configFor(provider, model),
    [{ role: "user", content: 'Reply with only the JSON {"ok":true}' }],
    // Generous headroom: reasoning runs at max effort, so reasoning-heavy
    // models (MiniMax) spend most of the budget thinking before
    // the tiny JSON answer.
    { json: true, maxTokens: 800 },
  );
  const parsed = text ? extractJson<{ ok?: unknown }>(text) : null;
  check(Boolean(parsed && parsed.ok !== undefined), `${model} answered in JSON mode`);
}

// --- 1. Movement intent -----------------------------------------------------
for (const role of ["crew", "imposter"] as const) {
  const intent = await intentWithModel(ai, view(role));
  console.log(`\n[${role}] intent:`, JSON.stringify(intent));
  check(intent !== null, `${role} agent returned a validated intent`);

  if (intent) {
    check(
      intent.action === "MOVE" || intent.action === "INTERACT",
      `${role} intent stays inside the MOVE/INTERACT vocabulary (no vent, no sabotage)`,
    );
  }
  if (intent?.action === "MOVE") {
    check(
      typeof intent.target === "string" && intent.target.trim().length > 0,
      "MOVE carries a destination the engine can resolve (zone, player or object)",
    );
  }
}

// --- 2. Meeting dialogue ----------------------------------------------------
const mind = createMind("crew:0", "crew");
remember(mind, {
  t: 40,
  kind: "kill",
  actorKey: "imp:0",
  roomId: "medbay",
  text: "Watched SHADE kill PIKE.",
});

const names = { "crew:0": "ROOK", "crew:1": "VEGA", "imp:0": "SHADE", "imp:1": "VEX", player: "ORION" };

const stmt = await statementWithModel(
  ai,
  UMBRA_DECK_MAP,
  mind,
  { key: "crew:0", name: "ROOK" },
  names,
  {
    others: ["crew:0", "crew:1", "imp:0", "player"],
    playerLine: "I was in the mess hall the whole time.",
    transcript: [
      { speaker: "ORION", text: "I was in the mess hall the whole time." },
      { speaker: "VEGA", text: "I found the body — who was even near MedBay?" },
    ],
    humanLines: ["I was in the mess hall the whole time."],
    turn: 1,
    bodiesFound: 1,
    ejectedSoFar: [],
  },
);

console.log("\n[meeting] statement:", JSON.stringify(stmt));
check(stmt !== null, "agent produced a validated meeting statement");
check((stmt?.line.length ?? 0) > 8, "statement is a real sentence");
check(!((stmt as { accuse?: unknown } | null)?.accuse), "statement carries no accusation field");
// The confessional rides on the same call: the private thought must come back
// on the `thinking` channel, distinct from the line the crew hears.
check(
  typeof stmt?.thinking === "string" && stmt.thinking.trim().length > 0,
  "statement also carries a private thought for the confessional",
);
check(
  (stmt?.thinking ?? "").trim() !== (stmt?.line ?? "").trim(),
  "the private thought is not just the public line repeated",
);

// --- 3. Imposter deflection ------------------------------------------------
const impMind = createMind("imp:0", "imposter", ["imp:1"]);
remember(impMind, {
  t: 30,
  kind: "flag",
  actorKey: "crew:1",
  roomId: "cafeteria",
  text: "ORION was seen loitering near the vents.",
});
const impStmt = await statementWithModel(
  ai,
  UMBRA_DECK_MAP,
  impMind,
  { key: "imp:0", name: "SHADE" },
  names,
  {
    others: ["crew:0", "crew:1", "imp:1"],
    playerLine: "SHADE was near the vents.",
    transcript: [{ speaker: "ORION", text: "SHADE was near the vents." }],
    humanLines: ["SHADE was near the vents."],
    turn: 2,
    bodiesFound: 1,
    ejectedSoFar: [],
  },
);
console.log("\n[meeting] imposter line:", JSON.stringify(impStmt));
check(impStmt !== null, "imposter produced a validated meeting statement");
check(!((impStmt as { accuse?: unknown } | null)?.accuse), "imposter statement carries no accusation field");

// --- 4. Station-log entry ---------------------------------------------------
// The generative task path: one sentence of real content the crew can read.
const brief = logBriefFor("task_medbay")!;
const logLine = await logEntryWithModel(ai, {
  authorName: "ROOK",
  brief,
  label: "Submit Scan",
  room: "MedBay",
  faked: false,
  traitor: false,
});
console.log("\n[log] entry:", JSON.stringify(logLine));
check(typeof logLine === "string" && logLine.length > 8, "agent wrote a station-log entry");
check((logLine ?? "").length <= 180, "the log entry respects its length cap");
check(!(logLine ?? "").includes("{"), "the log entry is prose, not raw JSON");

// An impostor's entry must be a cover story, and the engine marks it as such.
const impLog = await logEntryWithModel(ai, {
  authorName: "SHADE",
  brief,
  label: "Submit Scan",
  room: "MedBay",
  faked: true,
  traitor: true,
});
console.log("[log] imposter entry:", JSON.stringify(impLog));
check(typeof impLog === "string" && impLog.length > 8, "imposter wrote a cover-story entry");
check(
  !/imposter|traitor|kill/i.test(impLog ?? ""),
  "the cover story does not confess in writing",
);

console.log(`\nModel requests used: ${24 - ai.budget.remaining}`);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("Live model integration passed ✓");
