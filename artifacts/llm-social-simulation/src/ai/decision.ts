/**
 * The AI decision layer.
 *
 * Three questions, two interchangeable implementations of each:
 *
 *   1. Where should I go right now?      -> `intentWithModel` / `heuristicIntent`
 *   2. What should I say in the meeting? -> `statementWithModel` / `fallbackStatement`
 *   3. Who do I vote for?                -> always the belief model (see engine.ts)
 *
 * The model path asks the agent's configured provider (Pollinations or Berget)
 * for JSON and validates it. On *any* failure — no key, timeout, rate limit,
 * malformed JSON, unsupported action — it returns `null` and the caller uses
 * the scripted heuristic, which is why the game keeps running in an offline demo.
 */

import { complete, extractJson, type ChatMessage, type LlmConfig } from "./llm";
import { rankSuspects, type Mind } from "../game/perception";
import { heuristicStatement, memoryDigest, type NameIndex, type Statement } from "../game/dialogue";
import type { GameMap, RoomId } from "../game/map";
import { roomById } from "../game/map";

// ---------------------------------------------------------------------------
// What an agent knows about the world this tick
// ---------------------------------------------------------------------------

export interface ActorView {
  key: string;
  name: string;
  roomId: RoomId;
  roomName: string;
  alive: boolean;
  /** True only when the observer currently has line of sight to them. */
  visible: boolean;
  /** Distance from them to their nearest other companion — high means alone. */
  isolation: number;
}

export interface TaskRef {
  poiId: string;
  label: string;
  roomId: RoomId;
  roomName: string;
}

export interface WorldView {
  self: {
    key: string;
    name: string;
    role: "crew" | "imposter";
    roomId: RoomId;
    roomName: string;
    alive: boolean;
  };
  /** Crew: their own task list. Imposter: empty (they only fake). */
  tasks: (TaskRef & { done: boolean })[];
  /** Every task console, so imposters can fake one. */
  consoles: TaskRef[];
  vents: string[];
  others: ActorView[];
  recent: string[];
  suspicions: { name: string; score: number }[];
  sabotage: { kind: string; secondsLeft: number; fixPoiId: string; fixRoomId: RoomId } | null;
  cooldowns: { kill: number; sabotage: number };
  bodyOutstanding: boolean;
  taskProgress: number;
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

export type Intent =
  | { action: "goto_poi"; poiId: string }
  | { action: "goto_room"; roomId: RoomId }
  | { action: "group_up"; roomId: RoomId }
  | { action: "stalk"; target: string }
  | { action: "hunt" }
  | { action: "fake_task"; poiId: string }
  | { action: "vent"; poiId: string }
  | { action: "sabotage" };

const INTENT_ACTIONS = [
  "goto_poi",
  "goto_room",
  "group_up",
  "stalk",
  "hunt",
  "fake_task",
  "vent",
  "sabotage",
] as const;

type IntentAction = (typeof INTENT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const INTENT_SCHEMA =
  'Reply with ONLY a JSON object: {"action":"<one of ' +
  INTENT_ACTIONS.join("|") +
  '>","poiId":"<console id>","roomId":"<room id>","target":"<actor key>","reason":"<<=12 words>"} ' +
  "Include only the fields your chosen action needs. No prose, no markdown.";

function systemPrompt(view: WorldView): string {
  if (view.self.role === "imposter") {
    return [
      "You are a hidden traitor aboard a space station in a social-deduction game.",
      "Blend in: fake tasks, linger near crew, never act suspicious.",
      "Kill only when nobody has line of sight on you; use vents to escape afterwards.",
      "Trigger sabotage to split the crew up and buy cover.",
      "You are secretly allied with your fellow traitors and must never act against them.",
      INTENT_SCHEMA,
    ].join("\n");
  }
  return [
    "You are a crew member aboard a space station in a social-deduction game.",
    "Finish the station tasks and work out who the hidden traitors are.",
    "Keep moving between consoles; group up when a hazard or a body is found.",
    INTENT_SCHEMA,
  ].join("\n");
}

function summarise(view: WorldView): Record<string, unknown> {
  return {
    you: view.self,
    yourTasks: view.tasks,
    others: view.others,
    suspicion: view.suspicions,
    recentMemory: view.recent,
    sabotage: view.sabotage,
    cooldowns: view.cooldowns,
    bodyOutstanding: view.bodyOutstanding,
    taskProgress: Number(view.taskProgress.toFixed(2)),
    consoles: view.consoles.map((c) => c.poiId),
    vents: view.vents,
  };
}

function validateIntent(raw: unknown, view: WorldView): Intent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const action = obj.action;
  if (typeof action !== "string" || !(INTENT_ACTIONS as readonly string[]).includes(action)) {
    return null;
  }
  const poiId = typeof obj.poiId === "string" ? obj.poiId : undefined;
  const roomId = typeof obj.roomId === "string" ? (obj.roomId as RoomId) : undefined;
  const target = typeof obj.target === "string" ? obj.target : undefined;
  const knownRooms = new Set(view.consoles.map((c) => c.roomId));

  switch (action as IntentAction) {
    case "goto_poi":
    case "fake_task":
      return poiId && view.consoles.some((c) => c.poiId === poiId)
        ? { action: action as "goto_poi" | "fake_task", poiId }
        : null;
    case "vent":
      return poiId && view.vents.includes(poiId) ? { action: "vent", poiId } : null;
    case "goto_room":
    case "group_up":
      return roomId && knownRooms.has(roomId)
        ? { action: action as "goto_room" | "group_up", roomId }
        : null;
    case "stalk":
      return target && view.others.some((o) => o.key === target && o.alive)
        ? { action: "stalk", target }
        : null;
    case "hunt":
      return { action: "hunt" };
    case "sabotage":
      return view.self.role === "imposter" ? { action: "sabotage" } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Heuristic fallback (used when there is no key, or the model fails)
// ---------------------------------------------------------------------------

export function heuristicIntent(view: WorldView, rand: () => number): Intent {
  const consoles = view.consoles;
  const pickConsole = (): string =>
    consoles.length > 0 ? consoles[Math.floor(rand() * consoles.length)].poiId : "";

  if (view.self.role === "imposter") {
    if (!view.sabotage && view.cooldowns.sabotage <= 0 && rand() < 0.45) {
      return { action: "sabotage" };
    }

    // While the kill is ready, always make progress toward one: either close
    // on an isolated target you can already see, or go hunting for someone who
    // is alone. Wandering off to fake a task here is how a match deadlocks.
    if (view.cooldowns.kill <= 0) {
      const targets = view.others
        .filter((o) => o.alive && o.visible)
        .sort((x, y) => y.isolation - x.isolation);
      if (targets.length > 0) {
        const isolated =
          targets[0].isolation > 340
            ? targets[0]
            : targets[Math.floor(rand() * targets.length)];
        if (rand() < 0.75) return { action: "stalk", target: isolated.key };
      }
      if (rand() < 0.75) return { action: "hunt" };
      if (view.vents.length > 0 && rand() < 0.4) {
        return { action: "vent", poiId: view.vents[Math.floor(rand() * view.vents.length)] };
      }
      return { action: "fake_task", poiId: pickConsole() };
    }

    // Cooling down: keep the alibi warm.
    if (rand() < 0.55) return { action: "fake_task", poiId: pickConsole() };
    if (view.vents.length > 0 && rand() < 0.4) {
      return { action: "vent", poiId: view.vents[Math.floor(rand() * view.vents.length)] };
    }
    return { action: "hunt" };
  }

  // Crew: fix a live hazard first, then work their own list, then roam.
  if (view.sabotage && rand() < 0.75) {
    return { action: "goto_poi", poiId: view.sabotage.fixPoiId };
  }
  const open = view.tasks.filter((t) => !t.done);
  if (open.length > 0) {
    return { action: "goto_poi", poiId: open[Math.floor(rand() * open.length)].poiId };
  }
  if (view.bodyOutstanding && rand() < 0.5 && view.others.length > 0) {
    const nearest = view.others[Math.floor(rand() * view.others.length)];
    return { action: "group_up", roomId: nearest.roomId };
  }
  return { action: "goto_poi", poiId: pickConsole() };
}

// ---------------------------------------------------------------------------
// Model-backed decisions
// ---------------------------------------------------------------------------

export interface AiContext {
  cfg: LlmConfig | null;
  gate: { acquire: () => Promise<() => void> };
  /** Requests left this match; prevents runaway spend. */
  budget: { remaining: number };
}

export async function intentWithModel(ctx: AiContext, view: WorldView): Promise<Intent | null> {
  if (!ctx.cfg || ctx.budget.remaining <= 0 || !view.self.alive) return null;

  const release = await ctx.gate.acquire();
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
      // Reasoning models spend part of the budget thinking before the intent,
      // so leave headroom; the replies themselves are tiny.
      maxTokens: 220,
    });
    if (!text) return null;
    return validateIntent(extractJson<unknown>(text), view);
  } finally {
    release();
  }
}

export interface StatementInput {
  others: string[];
  /** What the human said earlier in this meeting, if anything. */
  playerLine: string | null;
  bodiesFound: number;
  ejectedSoFar: string[];
}

function statementSystem(mind: Mind): string {
  if (mind.role === "imposter") {
    return [
      "You are the hidden traitor in a social-deduction meeting aboard a space station.",
      "Stay calm, deflect, never reveal yourself, and push suspicion onto an innocent crew member.",
      "Do not contradict facts you could not possibly know.",
      'Reply with ONLY JSON: {"line":"<one or two sentences>","accuse":"<name or null>"}',
    ].join("\n");
  }
  return [
    "You are an honest crew member in a social-deduction meeting aboard a space station.",
    "Report what you remember and name who you suspect. One or two sentences, spoken aloud.",
    'Reply with ONLY JSON: {"line":"<one or two sentences>","accuse":"<name or null>"}',
  ].join("\n");
}

function nameOf(names: NameIndex, key: string): string {
  return names[key] ?? key;
}

function keyForName(names: NameIndex, name: string): string | null {
  const wanted = name.trim().toLowerCase();
  for (const [key, value] of Object.entries(names)) {
    if (value.toLowerCase() === wanted) return key;
  }
  return null;
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
    yourSuspicion: rankSuspects(mind, 0)
      .slice(0, 5)
      .map((s) => ({ name: nameOf(names, s.key), score: Number(s.score.toFixed(2)) })),
    alive: input.others.map((k) => nameOf(names, k)),
    bodiesFound: input.bodiesFound,
    ejectedSoFar: input.ejectedSoFar.map((k) => nameOf(names, k)),
    lastThingHumanSaid: input.playerLine,
    instruction:
      "Your vote will be calculated from your suspicion scores separately — only produce the spoken line and who you accuse.",
  };

  const release = await ctx.gate.acquire();
  try {
    if (ctx.budget.remaining <= 0) return null;
    ctx.budget.remaining--;

    const text = await complete(
      ctx.cfg,
      [
        { role: "system", content: statementSystem(mind) },
        { role: "user", content: JSON.stringify(payload) },
      ],
      // Generous enough that a reasoning model still emits the full JSON
      // object after its hidden reasoning tokens.
      { json: true, temperature: 0.85, maxTokens: 320 },
    );
    if (!text) return null;

    const parsed = extractJson<{ line?: unknown; accuse?: unknown }>(text);
    if (!parsed || typeof parsed.line !== "string" || parsed.line.trim().length === 0) return null;

    const line = parsed.line.trim().slice(0, 240);
    const accuse =
      typeof parsed.accuse === "string" ? keyForName(names, parsed.accuse) : null;
    return { line, accuse };
  } finally {
    release();
  }
}

/** Single fallback path used by the engine when the model is unavailable. */
export function fallbackStatement(
  map: GameMap,
  mind: Mind,
  speaker: { key: string; name: string },
  names: NameIndex,
  input: { others: string[]; playerLine: string | null },
): Statement {
  return heuristicStatement(map, mind, speaker, names, input);
}

export function roomNameOf(map: GameMap, roomId: RoomId): string {
  return roomById(map, roomId)?.name ?? roomId;
}
