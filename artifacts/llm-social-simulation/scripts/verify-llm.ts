/**
 * Live model check.
 *
 * Exercises the *real* network path the game uses: `readLlmConfig()` reads the
 * key from the environment, `intentWithModel` asks for a movement intent and
 * `statementWithModel` asks for a meeting line. Both are validated exactly as
 * the engine validates them, so a pass here means agent reasoning works against
 * the configured endpoint rather than only the heuristic fallback.
 *
 * Run: POLLINATIONS_API_KEY=pk_... bun scripts/verify-llm.ts
 *   or: BERGET_API_KEY=sk_ber_... bun scripts/verify-llm.ts
 */

import { intentWithModel, statementWithModel, type AiContext, type WorldView } from "../src/ai/decision";
import {
  complete,
  configFor,
  extractJson,
  readLlmConfig,
  readProviders,
  RequestGate,
} from "../src/ai/llm";
import { UMBRA_DECK_MAP } from "../src/game/map";
import { createMind, bump, remember } from "../src/game/perception";

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

const ai: AiContext = { cfg, gate: new RequestGate(0, 2), budget: { remaining: 20 } };

type ZoneRef = WorldView["zones"][number];

const zone = (id: string, name: string, kind: "room" | "corridor", adjacent = false): ZoneRef => ({
  id,
  name,
  kind,
  adjacent,
});

function view(role: "crew" | "imposter"): WorldView {
  const zones: ZoneRef[] = [
    zone("mess_hall", "Mess Hall", "room", true),
    zone("infirmary", "Infirmary", "room"),
    zone("power_bay", "Power Bay", "room"),
    zone("nav", "Nav Console", "room"),
    zone("hold", "Hold", "room"),
    zone("c_mess_med", "mess_hall ↔ infirmary", "corridor", true),
    zone("c_mess_watch", "mess_hall ↔ watchpost", "corridor", true),
  ];
  return {
    self: {
      key: role === "imposter" ? "imp:0" : "crew:0",
      name: role === "imposter" ? "SHADE" : "ROOK",
      role,
      roomId: "mess_hall",
      roomName: "Mess Hall",
      alive: true,
      zoneId: "mess_hall",
      zoneName: "Mess Hall",
    },
    current_location: "Mess Hall",
    current_time: "02:45",
    visible_players: ["VEGA"],
    valid_moves: zones.filter((z) => z.adjacent),
    zones,
    tasks: [
      { poiId: "task_mess", label: "Store rations", roomId: "mess_hall", roomName: "Mess Hall", done: false },
      { poiId: "task_med", label: "Scan vitals", roomId: "infirmary", roomName: "Infirmary", done: true },
    ],
    consoles: [
      { poiId: "task_mess", label: "Store rations", roomId: "mess_hall", roomName: "Mess Hall" },
      { poiId: "task_med", label: "Scan vitals", roomId: "infirmary", roomName: "Infirmary" },
      { poiId: "task_power", label: "Reset breaker", roomId: "power_bay", roomName: "Power Bay" },
    ],
    vents: ["vent_mess", "vent_med", "vent_power"],
    interactables: [
      { id: "task_mess", type: "TASK", name: "Store rations", status: "incomplete", in_range: true },
    ],
    system_message: null,
    others: [
      { key: "crew:1", name: "VEGA", roomId: "mess_hall", roomName: "Mess Hall", zoneId: "mess_hall", zoneName: "Mess Hall", alive: true, visible: true, isolation: 420, allied: false },
      { key: "crew:2", name: "JUNO", roomId: "infirmary", roomName: "Infirmary", zoneId: "infirmary", zoneName: "Infirmary", alive: true, visible: false, isolation: 90, allied: false },
      { key: "imp:1", name: "VEX", roomId: "hold", roomName: "Hold", zoneId: "hold", zoneName: "Hold", alive: true, visible: false, isolation: 300, allied: role === "imposter" },
    ],
    history: [
      "[00:40 sighted] Saw VEGA in Mess Hall not long ago.",
      "[01:20 task] Watched JUNO work a console in Infirmary.",
    ],
    suspicions: [{ name: "VEGA", score: 0.4 }],
    your_goal:
      role === "imposter" ? 'Fake work at "Reset breaker" in Power Bay (alibi)' : 'Work "Store rations" in Mess Hall',
    goal_since: "02:10",
    last_reasoning: role === "imposter" ? "build an alibi" : "next unfinished task",
    last_action: "Moving to Mess Hall",
    last_move: "Mess Hall",
    decision_history: [
      { at: "01:10", goal: 'Work "Store rations" in Mess Hall', action: "Moving to Mess Hall for \"Store rations\"", reasoning: "next unfinished task" },
      { at: "02:40", goal: 'Work "Store rations" in Mess Hall', action: "Moving to Mess Hall for \"Store rations\"", reasoning: "still the nearest console" },
    ],
    meeting_history: [
      {
        at: "01:30",
        reason: "SHADE reported a body",
        lines: ["SHADE: I found a body in Infirmary.", "VEGA: I was on tasks the whole time."],
        ejected: null,
      },
    ],
    sabotage: null,
    cooldowns: { kill: role === "imposter" ? 0 : 99, sabotage: role === "imposter" ? 0 : 99 },
    bodyOutstanding: false,
    taskProgress: 0.35,
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
    { json: true, maxTokens: 160 },
  );
  const parsed = text ? extractJson<{ ok?: unknown }>(text) : null;
  check(Boolean(parsed && parsed.ok !== undefined), `${model} answered in JSON mode`);
}

// --- 1. Movement intent -----------------------------------------------------
for (const role of ["crew", "imposter"] as const) {
  const intent = await intentWithModel(ai, view(role));
  console.log(`\n[${role}] intent:`, JSON.stringify(intent));
  check(intent !== null, `${role} agent returned a validated intent`);

  if (intent && (intent.action === "VENT" || intent.action === "SABOTAGE")) {
    check(role === "imposter", "vent/sabotage is only accepted from an imposter");
  }
  if (intent?.action === "MOVE") {
    const known = new Set(view(role).zones.map((z) => z.id.toLowerCase()));
    check(known.has(intent.target.toLowerCase()), "MOVE targets a known zone");
  }
}

// --- 2. Meeting dialogue ----------------------------------------------------
const mind = createMind("crew:0", "crew");
remember(mind, {
  t: 40,
  kind: "kill",
  actorKey: "imp:0",
  roomId: "infirmary",
  text: "Watched SHADE kill PIKE.",
});
bump(mind, "imp:0", 0.95);

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
    bodiesFound: 1,
    ejectedSoFar: [],
  },
);

console.log("\n[meeting] statement:", JSON.stringify(stmt));
check(stmt !== null, "agent produced a validated meeting statement");
check((stmt?.line.length ?? 0) > 8, "statement is a real sentence");
if (stmt?.accuse) {
  check(Object.keys(names).includes(stmt.accuse), "accusation maps back to a real agent key");
}

// --- 3. Imposter deflection ------------------------------------------------
const impMind = createMind("imp:0", "imposter", ["imp:1"]);
bump(impMind, "crew:1", 0.3);
const impStmt = await statementWithModel(
  ai,
  UMBRA_DECK_MAP,
  impMind,
  { key: "imp:0", name: "SHADE" },
  names,
  { others: ["crew:0", "crew:1", "imp:1"], playerLine: "SHADE was near the vents.", bodiesFound: 1, ejectedSoFar: [] },
);
console.log("\n[meeting] imposter line:", JSON.stringify(impStmt));
check(impStmt !== null, "imposter produced a validated meeting statement");
check(impStmt?.accuse !== "imp:1", "imposter never accuses its secret ally");

console.log(`\nModel requests used: ${20 - ai.budget.remaining}`);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("Live model integration passed ✓");
