/**
 * The AI decision layer.
 *
 * Three questions, two interchangeable implementations of each:
 *
 *   1. What should I do right now?      -> `intentWithModel` / `heuristicIntent`
 *   2. What should I say in the meeting? -> `statementWithModel` / `fallbackStatement`
 *   3. Who do I vote for?                -> always the belief model (see engine.ts)
 *
 * Movement is *node based* (PLAN.md): the engine serializes the agent's current
 * zone, the zones it can step into, the interactables it is standing among, who
 * it can see and the clock, and the model answers with a strict intent. `MOVE`
 * names a destination zone and the engine runs A* there.
 *
 * Object and player interactions go through `INTERACT` (PLAN.md): the model
 * picks a target and an `interaction_type` (TASK, KILL, FIX, REPORT,
 * EMERGENCY), and the engine acts as a referee — it checks distance, game state
 * and line of sight before anything happens. A rejected action never executes;
 * the failure is fed back to the agent as `system_message` on its next turn so
 * it can correct itself. Venting and sabotage were removed from the vocabulary:
 * no agent can enter a vent or trigger a sabotage, and the only role-gated
 * interaction left is the traitor's `KILL`.
 *
 * The model path asks the agent's configured provider for JSON and validates
 * it. On *any* failure — no key, timeout, rate limit, malformed JSON,
 * unsupported action — it returns `null` and the caller uses the scripted
 * heuristic, which is why the game keeps running in an offline demo.
 */

import { complete, extractJson, type ChatMessage, type LlmConfig } from "./llm";
import { type Mind } from "../game/perception";
import { heuristicStatement, memoryDigest, type NameIndex, type Statement } from "../game/dialogue";
import { buildLogPrompt, parseLogEntry, type LogBrief } from "../game/creative";
import type { GameMap, RoomId } from "../game/map";
import { roomById } from "../game/map";
import {
  isClaimKind,
  personaFor,
  type Claim,
  type DeceptionStyle,
} from "../game/deception";

// ---------------------------------------------------------------------------
// What an agent knows about the world this tick
// ---------------------------------------------------------------------------

/** A node in the station's zone graph, as handed to the model. */
export interface ZoneRef {
  id: string;
  name: string;
  kind: "room" | "corridor";
  /** True when directly connected to the agent's current zone. */
  adjacent: boolean;
}

/**
 * A player the agent can currently see — line of sight within vision range.
 * Nobody outside that circle ever appears in the snapshot.
 */
export interface ActorView {
  key: string;
  name: string;
  roomId: RoomId;
  roomName: string;
  zoneId: string;
  zoneName: string;
  /** Distance from them to the nearest other player in sight — high means alone. */
  isolation: number;
  /** True for a fellow traitor: never a target, never a suspect. */
  allied: boolean;
}

export interface TaskRef {
  poiId: string;
  label: string;
  roomId: RoomId;
  roomName: string;
}

/**
 * What the agent can do to something it is standing next to. The engine never
 * trusts this blindly — it re-checks distance, state and line of sight.
 */
export type InteractionType = "TASK" | "KILL" | "FIX" | "REPORT" | "EMERGENCY";

/** An object or actor in the agent's current node (PLAN.md step 1). */
export interface Interactable {
  /** Id the engine resolves: a POI id, an actor key, or a body id. */
  id: string;
  type: InteractionType;
  name: string;
  status: string;
  /** True only when the agent is physically able to act on it right now. */
  in_range: boolean;
}

export interface WorldView {
  self: {
    key: string;
    name: string;
    role: "crew" | "imposter";
    roomId: RoomId;
    roomName: string;
    alive: boolean;
    zoneId: string;
    zoneName: string;
  };
  /** --- Serialized spatial snapshot (PLAN.md step 2) --- */
  /** Human-readable name of the zone the agent currently occupies. */
  current_location: string;
  /** Simulation clock, "MM:SS". */
  current_time: string;
  /** Names of the agents the observer can currently see. */
  visible_players: string[];
  /** Zones directly connected to the current zone. */
  valid_moves: ZoneRef[];
  /** Every node in the station graph, so multi-hop targets resolve. */
  zones: ZoneRef[];
  /** --- Richer context for persona / rules / history --- */
  /** Crew: their own task list. Imposter: empty (they only fake). */
  tasks: (TaskRef & { done: boolean })[];
  /** Every task console, so imposters can fake one. */
  consoles: TaskRef[];
  /** Everything the agent can interact with from where it currently stands. */
  interactables: Interactable[];
  /** The engine's verdict on the agent's last rejected action, if any. */
  system_message: string | null;
  /** Every player the agent can currently see — and nobody else. */
  others: ActorView[];
  /** Fellow traitors by name; team knowledge an imposter always has. */
  known_allies: string[];
  /**
   * Where the agent itself last saw each player — its own sighting memory,
   * oldest information first by recency. Stale on purpose: it is what the
   * agent remembers, never a live position.
   */
  last_seen: { key: string; name: string; zoneId: string; zoneName: string; ago: number }[];
  /**
   * Every notable event this agent has observed this match, oldest first. This
   * is the complete match log — no event is ever dropped, so the opening of the
   * match is as available to the agent as the last second.
   */
  history: string[];
  /** --- Persistent self-context, carried across decision ticks --- */
  /** The purpose the agent committed to last time it acted. */
  your_goal: string | null;
  /** When that goal was adopted, "MM:SS", or null. */
  goal_since: string | null;
  /** Why the agent chose its last action, in its own words. */
  last_reasoning: string | null;
  /** One-line summary of the agent's last action. */
  last_action: string | null;
  /** The zone the agent last set out for, if any. */
  last_move: string | null;
  /** Every decision this agent has made this match, oldest first. */
  decision_history: {
    at: string;
    goal: string;
    action: string;
    reasoning: string | null;
  }[];
  /** Every meeting this agent attended this match, oldest first. */
  meeting_history: {
    at: string;
    reason: string;
    lines: string[];
    ejected: string | null;
  }[];
  /**
   * The name of the agent this one most suspects right now, or null for "no
   * strong lead". Engine-internal: it drives the offline heuristic's
   * emergency-beacon choice and is deliberately *not* serialized in
   * `summarise` — no suspicion value ever reaches a model prompt.
   */
  lead: string | null;
  cooldowns: { kill: number };
  /** True only while the agent can currently see an unreported body. */
  bodyOutstanding: boolean;
  taskProgress: number;
  /** --- carried over from previous shifts (see game/legacy.ts) --- */
  /** How many shifts this crew has already survived together. */
  shifts_played: number;
  /**
   * Names this agent walked in already distrusting because of a past match.
   * An opening bias only — never evidence for this round.
   */
  your_grudges: string[];
  /**
   * The deception persona a traitor was handed at roster build — null for
   * crew. It shapes how this agent lies (boldly, quietly, protectively), and is
   * what makes two traitors behave differently across matches.
   */
  your_personality: { label: string; playbook: string } | null;
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * The model's whole vocabulary. `MOVE` is the movement primitive (target is a
 * zone id or name); `INTERACT` is the interaction primitive (PLAN.md step 2),
 * carrying a target id and an interaction type. Working a console, killing,
 * reporting a body and calling an emergency meeting at the beacon are all
 * chosen by the agent and validated by the engine — never resolved by
 * proximity alone. There is no `VENT` or `SABOTAGE`: those abilities were
 * removed, and nothing in the game can trigger them any more.
 */
export type InteractIntent = {
  action: "INTERACT";
  target: string;
  interaction_type: InteractionType;
  /** Why the agent chose this, carried forward so it can reason between ticks. */
  reasoning?: string;
};

export type Intent = { action: "MOVE"; target: string; reasoning?: string } | InteractIntent;

const INTENT_ACTIONS = ["MOVE", "INTERACT"] as const;
type IntentAction = (typeof INTENT_ACTIONS)[number];
/**
 * What a model may ask the referee to do. `FIX` is deliberately absent — it
 * belonged to the sabotage system, which was removed; the engine keeps its
 * FIX case only for the headless checks that drive a sabotage directly.
 */
const INTERACTION_TYPES: InteractionType[] = ["TASK", "KILL", "REPORT", "EMERGENCY"];

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const INTENT_SCHEMA = [
  "Reply with ONLY a JSON object:",
  '{"action":"<one of ' + INTENT_ACTIONS.join("|") + '>","target":"<zone name, player name, or object id>","interaction_type":"<one of ' + INTERACTION_TYPES.join("|") + '>","reasoning":"<=12 words"}',
  'For MOVE, "target" is where you want to go: a zone name, a player name, or an object id you know of (a console, the beacon, or a body). The station walks you there.',
  'For INTERACT, "target" is an id from interactables and "interaction_type" says what to do; the station checks distance, game state and line of sight before it happens.',
  'EMERGENCY calls a meeting at the Cafeteria beacon (object id "emergency"): walk there first, then INTERACT with it when it is in range.',
  "Include only the fields your chosen action needs. No prose, no markdown.",
].join(" ");

function systemPrompt(view: WorldView): string {
  const common = [
    "You move around a space station that is described to you as a graph of zones",
    "(rooms joined by corridors). You name where to go — a zone, a player, or an",
    "object — and the station walks you there.",
    "You act on objects and people with INTERACT. A referee verifies every action and, if it",
    "is rejected, tells you why in system_message on your next turn so you can correct it.",
    "The Cafeteria emergency beacon (object id \"emergency\") calls an emergency meeting:",
    "walk there, then INTERACT with it. Use it when you have a real suspicion worth putting",
    "to the room — the crew then gathers to discuss and vote.",
    "You keep a memory between turns: your current goal, why you chose your last action, and",
    "a recap of every meeting. Nothing is forgotten: your_history holds every event you have",
    "observed this match, your_decisions holds every decision you have made, and your_goal /",
    "last_action / last_reasoning carry the current thread. Stay consistent with your goal; if",
    "you change your mind, say so in reasoning and commit to the new goal.",
    "You have played with this crew before: your_grudges lists anyone you walked in already",
    "watching (they wronged you in a past shift). Treat it as a hunch, not proof, and never",
    "cite a past match as evidence — this round has to be argued on this round's facts.",
    INTENT_SCHEMA,
  ];

  if (view.self.role === "imposter") {
    return [
      "You are a hidden traitor aboard a space station in a social-deduction game.",
      "Your goal is to eliminate crewmates secretly while never looking suspicious.",
    "You kill only by standing close to a lone crewmate with nobody watching, so move",
    "toward zones where a crewmate is isolated. You have no vents and no sabotages —",
    "stay hidden among the crew instead.",
    `Your fellow traitors: ${view.known_allies.length > 0 ? view.known_allies.join(", ") : "none"}. You can never act against them.`,
    `Kill cooldown: ${Math.ceil(view.cooldowns.kill)}s.`,
      view.your_personality
        ? `Your deception style is the ${view.your_personality.label}. ${view.your_personality.playbook}`
        : "Manage your alibi as carefully as your kills.",
      ...common,
    ].join("\n");
  }
  return [
    "You are a crew member aboard a space station in a social-deduction game.",
    "Finish the station tasks and work out who the hidden traitors are.",
    "Move toward zones that hold one of your unfinished task consoles; group up when a",
    "body is found. You do not know who the traitors are. When you have a real",
    "suspicion, walk to the Cafeteria emergency beacon and INTERACT with it to call an",
    "emergency meeting and put your read to the room.",
    ...common,
  ].join("\n");
}

function summarise(view: WorldView): Record<string, unknown> {
  return {
    current_location: view.current_location,
    current_time: view.current_time,
    visible_players: view.visible_players,
    valid_moves: view.valid_moves.map((z) => z.name),
    zones: view.zones.map((z) => z.name),
    you: view.self,
    yourTasks: view.tasks,
    others: view.others,
    known_allies: view.known_allies,
    last_seen: view.last_seen,
    your_history: view.history,
    your_decisions: view.decision_history,
    your_goal: view.your_goal,
    goal_since: view.goal_since,
    last_action: view.last_action,
    last_reasoning: view.last_reasoning,
    last_move: view.last_move,
    meeting_history: view.meeting_history,
    cooldowns: view.cooldowns,
    bodyOutstanding: view.bodyOutstanding,
    taskProgress: Number(view.taskProgress.toFixed(2)),
    interactables: view.interactables,
    system_message: view.system_message,
    shifts_played: view.shifts_played,
    your_grudges: view.your_grudges,
    your_personality: view.your_personality,
  };
}

export function validateIntent(raw: unknown, view: WorldView): Intent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const action = obj.action;
  if (typeof action !== "string") return null;
  const target = typeof obj.target === "string" ? obj.target : undefined;
  // The reasoning is optional free text; it is stored so the agent's next
  // prompt can show it what it was thinking, not rejected if malformed.
  const reasoning =
    typeof obj.reasoning === "string" ? obj.reasoning.trim().slice(0, 160) : undefined;

  switch (action.toUpperCase() as IntentAction) {
    case "MOVE": {
      if (!target) return null;
      // The engine resolves the reference — a zone, a player, an object or a
      // body — and walks there. An unresolvable name comes back as
      // system_message feedback on the agent's next turn.
      return { action: "MOVE", target: target.trim().slice(0, 80), reasoning };
    }
    case "INTERACT": {
      if (!target || typeof obj.interaction_type !== "string") return null;
      const itype = obj.interaction_type.toUpperCase() as InteractionType;
      if (!INTERACTION_TYPES.includes(itype)) return null;
      // Only the shape is validated here; the engine is the referee for
      // distance, game state and line of sight (PLAN.md step 3).
      return { action: "INTERACT", target, interaction_type: itype, reasoning };
    }
    default:
      // `VENT` and `SABOTAGE` land here: they are no longer part of the
      // vocabulary, so a model that still emits one is refused outright.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Heuristic fallback (used when there is no key, or the model fails)
// ---------------------------------------------------------------------------

/**
 * Choose a destination zone using the same node data the model sees. Returns a
 * zone id; the engine resolves it and paths from the current node.
 */

export function heuristicIntent(view: WorldView, rand: () => number): Intent {
  const pickFrom = <T>(arr: T[]): T | null => (arr.length > 0 ? arr[Math.floor(rand() * arr.length)] : null);
  const pickZone = (): string => {
    const room = pickFrom(view.zones.filter((z) => z.kind === "room"));
    return (room ?? view.valid_moves[0] ?? view.zones[0]).id;
  };
  const pickValid = (): string => (pickFrom(view.valid_moves) ?? view.zones[0])?.id ?? view.self.zoneId;
  const ready = (type: InteractionType): Interactable | null =>
    view.interactables.find((i) => i.type === type && i.in_range) ?? null;

  if (view.self.role === "imposter") {
    // A validated kill beats any movement — pounce on an isolated target.
    const kill = ready("KILL");
    if (kill)
      return {
        action: "INTERACT",
        target: kill.id,
        interaction_type: "KILL",
        reasoning: "isolated target in range",
      };

    if (view.cooldowns.kill <= 0) {
      // Everyone in `others` is currently in sight — the view never contains a
      // player the agent cannot see, so there is no off-screen hunting.
      const prey = view.others.filter((o) => !o.allied).sort((a, b) => b.isolation - a.isolation);
      if (prey.length > 0 && rand() < 0.8)
        return { action: "MOVE", target: prey[0].key, reasoning: "prey is visible and alone" };
      // No one in sight: hunt where the agent itself last saw someone. That is
      // memory, not tracking — by the time it arrives the trail may be cold.
      const trail = view.last_seen.filter((s) => !view.others.some((o) => o.key === s.key));
      const lead = pickFrom(trail.slice(0, 3));
      if (lead)
        return {
          action: "MOVE",
          target: lead.zoneId,
          reasoning: `head to where I last saw ${lead.name}`,
        };
      return { action: "MOVE", target: pickZone(), reasoning: "hunt while the kill is ready" };
    }

    // Cooling down: keep the alibi warm.
    if (rand() < 0.5) {
      const console = pickFrom(view.consoles);
      return {
        action: "MOVE",
        target: console ? console.poiId : pickZone(),
        reasoning: "build an alibi while the kill recharges",
      };
    }
    return { action: "MOVE", target: pickValid(), reasoning: "reposition quietly" };
  }

  const task = ready("TASK");
  if (task)
    return {
      action: "INTERACT",
      target: task.id,
      interaction_type: "TASK",
      reasoning: "console is in range",
    };
  const report = ready("REPORT");
  if (report)
    return {
      action: "INTERACT",
      target: report.id,
      interaction_type: "REPORT",
      reasoning: "a body needs reporting",
    };

  // A real lead at the beacon becomes a meeting: the crewmate presses the
  // button and puts its read to the room. The engine referees the press like
  // any other interaction — distance, line of sight, and the 45s lockout
  // after every meeting — and only a crew with an actual suspicion bothers.
  const beacon = view.interactables.find((i) => i.type === "EMERGENCY");
  if (beacon?.in_range && view.lead && rand() < 0.5) {
    return {
      action: "INTERACT",
      target: beacon.id,
      interaction_type: "EMERGENCY",
      reasoning: `put my read on ${view.lead} to the room`,
    };
  }
  if (view.lead) {
    // Walk to the beacon when it is not on hand: straight to the button when
    // this agent is already in Cafeteria but out of reach, or across the
    // station from anywhere else. Probabilistic, so a lead never fully derails
    // the task list.
    if (!beacon && rand() < 0.15) {
      return { action: "MOVE", target: "emergency", reasoning: "raise my suspicion at the beacon" };
    }
    if (beacon && !beacon.in_range && beacon.status === "ready" && rand() < 0.4) {
      return { action: "MOVE", target: beacon.id, reasoning: "get within reach of the beacon" };
    }
  }

  // Crew that drift alone get picked off, and pairs are how bodies get found:
  // when nobody is in sight, sometimes regroup toward the last person the
  // agent itself saw (memory, not tracking).
  if (view.others.length === 0 && rand() < 0.3) {
    const lead = pickFrom(view.last_seen);
    if (lead)
      return { action: "MOVE", target: lead.zoneId, reasoning: `stay near ${lead.name}` };
  }

  const open = view.tasks.filter((t) => !t.done);
  if (open.length > 0) {
    const next = pickFrom(open);
    if (next) return { action: "MOVE", target: next.poiId, reasoning: "next unfinished task" };
  }
  if (view.bodyOutstanding && rand() < 0.5) {
    // Only crew currently in sight can be regrouped with — the body itself is
    // visible too, otherwise the agent would not know a body exists.
    const witness = pickFrom(view.others);
    return {
      action: "MOVE",
      target: witness ? witness.zoneId : pickValid(),
      reasoning: "regroup after a body",
    };
  }
  return { action: "MOVE", target: pickZone(), reasoning: "patrol for tasks or information" };
}

// ---------------------------------------------------------------------------
// Model-backed decisions
// ---------------------------------------------------------------------------

export interface AiContext {
  cfg: LlmConfig | null;
  gate?: { acquire: () => Promise<unknown> };
  /** Requests left this match; prevents runaway spend. */
  budget: { remaining: number };
  /**
   * Observes the model's raw reply exactly as it came back, before any
   * validation. The thought feed uses it to show what the model actually
   * said — including replies the validator went on to refuse.
   */
  onRaw?: (raw: string) => void;
}

export async function intentWithModel(ctx: AiContext, view: WorldView): Promise<Intent | null> {
  if (!ctx.cfg || ctx.budget.remaining <= 0 || !view.self.alive) return null;

  const release = ctx.gate?.acquire?.();
  if (release) await release;
  try {
    if (ctx.budget.remaining <= 0) return null;
    ctx.budget.remaining--;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(view) },
      { role: "user", content: JSON.stringify(summarise(view)) },
    ];
    const text = await complete(ctx.cfg, messages, {
      json: true,
      temperature: 0.5,
      // Reasoning runs at max effort, so leave generous headroom for thinking
      // tokens before the intent; the replies themselves are tiny.
      maxTokens: 600,
    });
    if (!text) return null;
    ctx.onRaw?.(text);
    return validateIntent(extractJson<unknown>(text), view);
  } finally {
    if (release) await release;
  }
}

export interface StatementInput {
  others: string[];
  /** What the human said earlier in this meeting, if anything. */
  playerLine: string | null;
  /**
   * The running discussion so far — every spoken line this meeting, including
   * the human's — so agents respond to the actual conversation instead of
   * talking past each other.
   */
  transcript: { speaker: string; text: string }[];
  /** Every line the human said this meeting, oldest first. Always read in full. */
  humanLines: string[];
  /** How many times this agent has already spoken this meeting (1-based). */
  turn: number;
  bodiesFound: number;
  ejectedSoFar: string[];
  /** The speaker's deception persona, when it is a traitor. */
  style?: DeceptionStyle | null;
  /** The room a scripted traitor will claim it was working in. */
  alibiRoomId?: RoomId | null;
}

/** The structured-claim instruction shared by both roles. */
const CLAIM_SCHEMA =
  'Optionally add "claim" when you assert something the room can act on: {"kind":"accuse"|"vouch"|"alibi","about":"<player name>","room":"<room name or empty>","detail":"<=6 words"}. Use "accuse" to point at someone, "vouch" to clear someone, and "alibi" to say where you were (for an alibi, about is yourself).';

function statementSystem(mind: Mind, style?: DeceptionStyle | null): string {
  const live = [
    "This is a live group discussion: read the conversation so far, react to what others — including the human player — said, and answer the human directly if they addressed you.",
    "Never repeat a line that anyone has already said.",
    "Speak for yourself. Say what you saw, what you remember and what you believe — do not formally demand a vote; that is the room's call, not yours.",
    CLAIM_SCHEMA,
    // The two-channel reply is the confessional: `line` is heard by the crew,
    // `thinking` is heard only by the audience.
    'Also fill "thinking": your private read of the room, at most 15 words. It is NEVER spoken aloud and the other players never see it, so it may be candid — what you really believe, what you are hiding, and who you are steering toward.',
    "Your thinking must match your true role and intention, not your public line.",
    'Reply with ONLY JSON: {"line":"<one or two sentences>","thinking":"<at most 15 words, private>"}',
  ];
  if (mind.role === "imposter") {
    const persona = style ? personaFor(style) : null;
    return [
      "You are the hidden traitor in a social-deduction meeting aboard a space station.",
      "Stay calm, deflect, never reveal yourself, and steer suspicion toward an innocent crew member through what you say.",
      persona
        ? `Your deception style is the ${persona.label}. ${persona.playbook}`
        : "Manage your story carefully and never contradict facts you could not know.",
      "You may lie in a claim: fabricate a sighting to frame a crewmate, vouch for your fellow traitor, or give yourself an alibi. But a listener who saw the truth with its own eyes will catch you — prefer claims the room cannot verify.",
      ...live,
    ].join("\n");
  }
  return [
    "You are an honest crew member in a social-deduction meeting aboard a space station.",
    "Report what you remember and share who you find suspicious. One or two sentences, spoken aloud.",
    "Claim only what you actually saw or believe; you have no reason to invent anything.",
    ...live,
  ].join("\n");
}

/** Resolve a spoken room name/id back to a RoomId, or undefined if unknown. */
function resolveRoom(map: GameMap, raw: unknown): RoomId | undefined {
  if (typeof raw !== "string") return undefined;
  const q = raw.trim().toLowerCase();
  if (!q) return undefined;
  const room = map.rooms.find(
    (r) => r.id === q || r.name.toLowerCase() === q || r.short.toLowerCase() === q,
  );
  return room?.id;
}

function detailOf(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  return t ? t.slice(0, 60) : undefined;
}

/** Resolve a player name (or key) to a living actor key, restricted to `others`. */
function resolveActor(names: NameIndex, others: string[], raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.trim().toLowerCase();
  if (!q) return null;
  for (const key of others) {
    if (key.toLowerCase() === q || (names[key] ?? "").toLowerCase() === q) return key;
  }
  return null;
}

/**
 * Validate the model's optional structured claim. Only the shape is checked
 * here; the engine remains the referee for what a claim is worth. A traitor
 * may lie freely; a crewmate may not manufacture an alibi it did not make, and
 * nobody claims anything about an ally.
 */
function parseClaim(
  raw: unknown,
  map: GameMap,
  mind: Mind,
  speaker: { key: string; name: string },
  names: NameIndex,
  input: StatementInput,
): Claim | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind !== "string" || !isClaimKind(obj.kind)) return null;
  const kind = obj.kind;

  if (kind === "alibi") {
    // Only a traitor scripts an alibi; an honest crewmate reports what it saw.
    if (mind.role !== "imposter") return null;
    return { kind, about: speaker.key, roomId: resolveRoom(map, obj.room), detail: detailOf(obj.detail) };
  }

  const target = resolveActor(names, input.others, obj.about);
  if (!target || target === speaker.key) return null;
  if (mind.allies.includes(target)) return null;
  return { kind, about: target, roomId: resolveRoom(map, obj.room), detail: detailOf(obj.detail) };
}

function nameOf(names: NameIndex, key: string): string {
  return names[key] ?? key;
}

export async function statementWithModel(
  ctx: AiContext,
  map: GameMap,
  mind: Mind,
  speaker: { key: string; name: string },
  names: NameIndex,
  input: StatementInput,
): Promise<Statement | null> {
  if (!ctx.cfg || ctx.budget.remaining <= 0) return null;

  const payload = {
    speaker: speaker.name,
    youAreTraitor: mind.role === "imposter",
    secretAllies: mind.allies.map((k) => nameOf(names, k)),
    yourMemory: memoryDigest(map, mind, names),
    alive: input.others.map((k) => nameOf(names, k)),
    bodiesFound: input.bodiesFound,
    ejectedSoFar: input.ejectedSoFar.map((k) => nameOf(names, k)),
    whatTheHumanSaid: input.humanLines,
    conversationSoFar: input.transcript,
    yourTurnNumber: input.turn,
    yourGoal: mind.goal,
    // The complete meeting record, not a tail: every line from every meeting.
    meetingHistory: mind.meetings.map((m) => ({
      at: m.t,
      reason: m.reason,
      lines: m.lines,
      ejected: m.ejected ? m.ejected.name : null,
    })),
    yourDeceptionStyle: mind.role === "imposter" && input.style ? personaFor(input.style).label : null,
    instruction:
      "This discussion is ongoing — build on the conversation so far and on what the human said (answer them directly if they spoke to you), and never repeat anything already said. Speak for yourself, from your own memory: only produce the spoken line.",
  };      const release = ctx.gate?.acquire?.();
      if (release) await release;
  try {
    if (ctx.budget.remaining <= 0) return null;
    ctx.budget.remaining--;

    const text = await complete(
      ctx.cfg,
      [
        { role: "system", content: statementSystem(mind, input.style) },
        { role: "user", content: JSON.stringify(payload) },
      ],
      // Generous enough that a max-effort reasoning model still emits the
      // full JSON object after its hidden reasoning tokens.
      { json: true, temperature: 0.85, maxTokens: 900 },
    );
    if (!text) return null;
    ctx.onRaw?.(text);

    const parsed = extractJson<{ line?: unknown; thinking?: unknown; claim?: unknown }>(text);
    if (!parsed || typeof parsed.line !== "string" || parsed.line.trim().length === 0) return null;

    const line = parsed.line.trim().slice(0, 240);
    const thinking =
      typeof parsed.thinking === "string" && parsed.thinking.trim().length > 0
        ? parsed.thinking.trim().slice(0, 200)
        : null;
    const claim = parseClaim(parsed.claim, map, mind, speaker, names, input);
    return { line, thinking, claim };
  } finally {
    if (release) await release;
  }
}

/**
 * Write one station-log entry at a generative console (see `game/creative.ts`).
 *
 * This is the only *creative* model call in the game and it is deliberately the
 * cheapest: one sentence, capped tokens, no reasoning effort, and the caller
 * caps how many a match may make. A refusal, a timeout or a malformed reply
 * returns null and the engine falls back to the console's template, so the log
 * always fills and the match never stalls.
 */
export async function logEntryWithModel(
  ctx: AiContext,
  args: {
    authorName: string;
    brief: LogBrief;
    label: string;
    room: string;
    faked: boolean;
    traitor: boolean;
  },
): Promise<string | null> {
  if (!ctx.cfg || ctx.budget.remaining <= 0) return null;

  const { system, user } = buildLogPrompt({ ...args, brief: args.brief.brief });      const release = ctx.gate?.acquire?.();
      if (release) await release;
  try {
    if (ctx.budget.remaining <= 0) return null;
    ctx.budget.remaining--;

    const text = await complete(
      ctx.cfg,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { json: true, temperature: 0.95, maxTokens: 200, reasoningEffort: "low" },
    );
    if (!text) return null;
    ctx.onRaw?.(text);
    return parseLogEntry(text);
  } finally {
    if (release) await release;
  }
}

/** Single fallback path used by the engine when the model is unavailable. */
export function fallbackStatement(
  map: GameMap,
  mind: Mind,
  speaker: { key: string; name: string },
  names: NameIndex,
  input: StatementInput,
): Statement {
  return heuristicStatement(map, mind, speaker, names, {
    others: input.others,
    playerLine: input.playerLine,
    turn: input.turn,
    alibiRoomId: input.alibiRoomId ?? null,
    style: input.style ?? null,
  });
}

export function roomNameOf(map: GameMap, roomId: RoomId): string {
  return roomById(map, roomId)?.name ?? roomId;
}
