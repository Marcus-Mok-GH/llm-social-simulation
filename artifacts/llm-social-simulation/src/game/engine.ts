/**
 * The game engine.
 *
 * Owns the whole match: roles, the phase state machine (briefing -> playing ->
 * meeting -> ended), perception, kills, sabotage, meetings and win conditions.
 * It is deliberately free of React and of wall-clock time — `tick(dt)` is the
 * only way anything advances, so `scripts/simulate.ts` can replay a full match
 * headlessly at 60 Hz and assert on the outcome.
 *
 * The AI layer is pluggable: every decision goes through `decide()`, which
 * tries the model first and falls back to the scripted heuristic, and every
 * meeting line goes through `speak()`. With no API key the match still plays
 * out in full, which is the property that makes the game demoable.
 */

import {
  fallbackStatement,
  heuristicIntent,
  intentWithModel,
  logEntryWithModel,
  statementWithModel,
  type AiContext,
  type Intent,
  type InteractIntent,
  type Interactable,
  type WorldView,
} from "../ai/decision";
import {
  activeProvider,
  configFor,
  modelDisplayName,
  RequestGate,
  type LlmConfig,
  type LlmProvider,
  type ProviderConfig,
} from "../ai/llm";
import {
  canStand,
  nearestStandable,
} from "./collision";
import {
  createCrewmates,
  crewmateGotoPoint,
  crewmateGotoPoi,
  crewmateHalt,
  crewmateHold,
  crewmateWorkAt,
  updateCrewmate,
  type Crewmate,
} from "./crewmate";
import {
  confessionalFallback,
  ghostStatement,
  heuristicStatement,
  type NameIndex,
  type Statement,
} from "./dialogue";
import {
  createImposters,
  imposterGotoPoint,
  imposterHalt,
  updateImposter,
  type Imposter,
} from "./imposter";
import { inputVectorFromKeys, type MoveInput } from "./input";
import {
  nearestPoi,
  roomAt,
  UMBRA_DECK_MAP as DEFAULT_MAP,
  type GameMap,
  type PointOfInterest,
  type RoomId,
} from "./map";
import {
  LOG_ENTRY_MAX,
  LOG_MODEL_CALLS_MAX,
  logBriefFor,
  templateLogEntry,
  type StationLogEntry,
} from "./creative";
import { type MatchEvent } from "./events";
import {
  loadLegacy,
  seedGrudges,
  type LegacyEjection,
  type LegacyLedger,
  type LegacyMatchSummary,
} from "./legacy";
import { buildNavGrid, type NavGrid } from "./navigation";
import {
  buildZoneGraph,
  formatClock,
  standPoint,
  zoneAtPoint,
  zoneByRef,
  zoneNeighbors,
  type Zone,
  type ZoneGraph,
} from "./zones";
import {
  createMind,
  decay,
  noteSighting,
  rankSuspects,
  remember,
  rememberMeeting,
  setGoal,
  topSuspect,
  type Mind,
  type Role,
} from "./perception";
import {
  claimMemoryText,
  contradictionNote,
  judgeClaim,
  personaFor,
  styleForIndex,
  type Claim,
  type DeceptionStyle,
} from "./deception";
import { createPlayer, updatePlayer, type Player } from "./player";
import { makeRng, type Rng } from "./rng";
import {
  assignTasks,
  minigameKind,
  PLAYER_TASKS,
  TASKS_PER_CREW,
  taskBarFraction,
  type TaskAssignment,
} from "./tasks";
import {
  buildVisibilityGrid,
  castVision,
  makeLosTest,
  revealAround,
  type VisibilityGrid,
} from "./vision";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const AI_CREW = 4;
export const KILL_RANGE = 44;
/**
 * How close someone must be to *witness* a kill. Deliberately much shorter
 * than `BASE_VISION`: you can see across a hall, but you cannot make out a
 * murder through three doorways, and imposters need room to exist.
 */
export const KILL_WITNESS_RANGE = 230;
export const KILL_COOLDOWN = 26;
export const SABOTAGE_COOLDOWN = 34;
/**
 * Time to repair the reactor meltdown. Among Us gives The Skeld 30 seconds
 * (MIRA HQ gets 45, The Fungle 60) — and this deck is The Skeld.
 */
export const MELTDOWN_TIME = 30;
export const BLACKOUT_TIME = 30;
export const REPAIR_TIME = 4;
export const BASE_VISION = 430;
export const BLACKOUT_VISION = 175;
export const INTERACT_RANGE = 52;
/**
 * Match pacing guards. A game where neither side can still win should not run
 * forever: after `OVERTIME_AT` the traitors get restless, and at `MATCH_LIMIT`
 * the shift is called and the station is judged on how much work got done.
 */
export const OVERTIME_AT = 300;
export const MATCH_LIMIT = 600;
const DISCUSSION_TIME = 60;
const VOTING_TIME = 20;
const TALLY_TIME = 6;
/**
 * How long a speaker may hold the token before the engine forcibly frees it.
 * It only ever matters when a model reply never lands — the heuristic path
 * releases the token the instant its line is posted.
 */
const SPEAKER_DEADLINE = 20;
/** Wait between turns, jittered — the room's natural back-and-forth rhythm. */
const TURN_GAP_MIN = 2.2;
const TURN_GAP_JITTER = 2.4;
/**
 * How many recent transcript lines each agent reads before speaking, so the
 * discussion is a real back-and-forth: agents answer each other and the human
 * instead of monologuing from memory alone.
 */
const TRANSCRIPT_WINDOW = 14;
/**
 * Statements now flow for the whole discussion window (a turn every few
 * seconds per meeting), so the shared budget needs headroom above what the
 * movement-intent loop alone consumed.
 */
const LLM_BUDGET = 240;
/**
 * How many agent thoughts the feed keeps. Sized to outlive a full match's
 * decision volume so entries are actually evicted (the ring property is
 * observable), while old entries fall off the front during long matches.
 */
const THOUGHT_FEED_MAX = 24;
/**
 * How many raw model replies (decisions + meeting lines) the feed keeps.
 * Separate from `THOUGHT_FEED_MAX` because a JSON blob is a different thing
 * from a decision row — the two lists are both shown and neither should
 * crowd the other out.
 */
const RAW_JSON_MAX = 18;
/**
 * How many confessional rows the panel keeps. Larger than the thought feed: a
 * confessional is short and the audience wants the arc, not just the last line.
 */
const CONFESSIONAL_MAX = 36;
/**
 * The crew channel never drains below this. The panel's whole point is the
 * gap between the candid and the covering channel, so a late-game run of
 * pure traitor cover stories must never crowd the crew's thoughts out
 * entirely — above the floor, the oldest candid entry still goes first so
 * an ejected liar's covers stay on the record.
 */
const CONFESSIONAL_CANDID_FLOOR = 6;

/**
 * One row of the per-agent confessional: what an agent was *really* thinking
 * when it did or said the thing above it. This is the audience's channel — the
 * rest of the crew never sees it, which is what makes watching a lie land so
 * much better than watching a log of it.
 */
export interface ConfessionalEntry {
  id: number;
  /** Simulation time in seconds. */
  t: number;
  key: string;
  name: string;
  color: string;
  /** The agent's role — the panel it is talking to is trusted, not public. */
  role: "crew" | "imposter";
  /** What the audience just watched it do or hear it say. */
  action: string;
  /** The private thought itself. */
  thought: string;
  /** Where the thought came from. */
  source: ThoughtSource;
  /**
   * True when the public `action` and the private `thought` disagree — an
   * impostor covering, which is exactly the moment worth watching. Computed on
   * role, not by diffing text: a traitor's confessional is always a cover story.
   */
  concealing: boolean;
}

export type Phase = "briefing" | "playing" | "meeting" | "ended";
export type Winner = "crew" | "imposter" | null;
export type SabotageKind = "meltdown" | "blackout";

/**
 * An actor's participation status — the single source of truth for whether
 * someone is on the deck, dead, watching from the gallery, or has dropped out.
 *
 * `Actor.alive` is *derived* from this (see the getter), so the two can never
 * disagree. `spectator` and `disconnected` are reserved for the human seat; an
 * AI actor is only ever `alive` or `dead`. Every change goes through
 * `GameEngine.setActorStatus`, which owns the mechanical side effects.
 */
export type ActorStatus = "alive" | "dead" | "spectator" | "disconnected";

/** True only in the one status where an actor takes part in the match. */
export function isParticipating(status: ActorStatus): boolean {
  return status === "alive";
}

// ---------------------------------------------------------------------------
// Communication channels
// ---------------------------------------------------------------------------

/**
 * Which lane a message travels on. Every channel has a declared audience, so a
 * new lane is added here rather than by threading an audience check through
 * every reader.
 */
export type ChannelId =
  | "meeting"
  | "system"
  | "station-log"
  | "confessional"
  | "thought"
  | "ghost";

/** Who may read a channel. */
export type ChannelAudience = "everyone" | "living" | "dead" | "spectators";

/** A first-class communication channel: its audience, spoiler status and cap. */
export interface ChannelDef {
  id: ChannelId;
  label: string;
  audience: ChannelAudience;
  /**
   * Whether content here may move a reader's beliefs. Only the meeting channel
   * carries structured claims, and only those go through `applyClaim` — the
   * ghost channel is explicitly inert.
   */
  movesBelief: boolean;
  /** Hidden from anyone who is not a spectator until the match ends. */
  spoiler: boolean;
  /** Ring-buffer cap in messages (0 = keep the whole match). */
  retention: number;
}

export const CHANNELS: Record<ChannelId, ChannelDef> = {
  meeting: { id: "meeting", label: "Meeting", audience: "everyone", movesBelief: true, spoiler: false, retention: 0 },
  system: { id: "system", label: "Station", audience: "everyone", movesBelief: false, spoiler: false, retention: 0 },
  "station-log": { id: "station-log", label: "Station Log", audience: "everyone", movesBelief: false, spoiler: false, retention: 0 },
  confessional: { id: "confessional", label: "Confessional", audience: "spectators", movesBelief: false, spoiler: true, retention: 0 },
  thought: { id: "thought", label: "Thought Feed", audience: "spectators", movesBelief: false, spoiler: true, retention: 0 },
  ghost: { id: "ghost", label: "Ghost Channel", audience: "dead", movesBelief: false, spoiler: true, retention: 80 },
};

/**
 * How long a single ghost holds the channel before another may speak, and the
 * hush that follows — together they are what makes the ghost channel strictly
 * one-voice-at-a-time.
 */
export const GHOST_TALK_TIME = 3.2;
export const GHOST_QUIET_TIME = 1.6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: number;
  t: number;
  speakerKey: string;
  speakerName: string;
  color: string;
  text: string;
  kind: "statement" | "system" | "player" | "ghost";
  /** The lane this message travels on — see `CHANNELS`. */
  channel: ChannelId;
}

export interface Body {
  id: number;
  key: string;
  name: string;
  color: string;
  x: number;
  y: number;
  roomId: RoomId;
}

/** Where a decision or meeting line came from: the live model or the fallback. */
export type ThoughtSource = "model" | "heuristic";

/** One raw model reply in the feed's JSON log, exactly as the provider returned it. */
export interface RawJsonEntry {
  id: number;
  /** Simulation time in seconds. */
  t: number;
  key: string;
  name: string;
  color: string;
  text: string;
}

/**
 * One entry in the spectator thought feed: what an AI agent just decided to
 * do and, in its own words, why. Written by `recordDecision` — the single
 * choke point every intent (model or heuristic) passes through. Entries that
 * came from a live model also carry the raw JSON reply it emitted, exactly as
 * the provider returned it, before the engine validated or applied anything.
 */
export interface ThoughtEntry {
  id: number;
  /** Simulation time in seconds. */
  t: number;
  key: string;
  name: string;
  color: string;
  /** One-line summary of the action the agent took. */
  action: string;
  /** The agent's own reasoning, or null when it did not offer one. */
  reasoning: string | null;
  /** Which path produced this decision. */
  source: ThoughtSource;
  /** The model's raw JSON reply, when this decision came from a live model. */
  json: string | null;
}

export type EntityKind = "player" | "crew" | "imposter";

export interface Actor {
  key: string;
  name: string;
  color: string;
  role: "crew" | "imposter";
  kind: EntityKind;
  isPlayer: boolean;
  /**
   * Participation status. The engine never writes this directly — every
   * change goes through `GameEngine.setActorStatus`, which owns the side
   * effects (halting a corpse, freeing the player's input, recounting tasks).
   */
  status: ActorStatus;
  /** Derived from `status`, kept as a field so existing reads stay valid. */
  readonly alive: boolean;
  /** Node-graph zone the actor currently occupies (PLAN.md step 1). */
  zoneId: string;
  entity: Player | Crewmate | Imposter;
  mind: Mind;
  /** Model endpoint for this agent only. `null` on the human and with no key. */
  cfg: LlmConfig | null;
  tasks: TaskAssignment[];
  /** Completions already examined by the task-bar accounting. */
  processed: number;
  /** Completions actually counted toward the shared bar. */
  counted: number;
  nextDecisionAt: number;
  decisionSeq: number;
  pendingDecision: boolean;
  /** Earliest time the agent may be nudged to decide because it can act here. */
  urgencyAt: number;
  /** Engine verdict on the agent's last rejected interaction, fed back next turn. */
  actionFeedback: string | null;
  /** Body this agent intends to report, if any. */
  bodyToReport: number | null;
  /** Traitors get a deception persona; crew and the human have none. */
  deceptionStyle: DeceptionStyle | null;
  repathAt: number;
  killCooldown: number;
  /** Time until which this agent counts as actively repairing a sabotage. */
  fixUntil: number;
  voteAt: number;
}

/**
 * The right to speak. Exactly one agent holds this at a time, and holding it is
 * the only way to add a line to a meeting transcript.
 */
export interface SpeakerToken {
  key: string;
  name: string;
  /** Monotonic per-meeting turn id; a stale async reply carries an old seq. */
  seq: number;
  /** Simulation time the token was granted. */
  since: number;
}

/**
 * A first-class meeting: the whole deliberation from report to verdict.
 *
 * The discussion is serialized by a single **speaker token** (`speaker`): only
 * the holder may speak, and the next turn is granted only once the holder's
 * line has landed. That keeps a meeting strictly one voice at a time even when
 * a model reply is slow — which a per-turn timer alone cannot guarantee, since
 * two timers can elapse before either answer arrives.
 */
export interface Meeting {
  startedAt: number;
  stage: "discussion" | "voting" | "tally";
  timer: number;
  reason: { kind: "emergency" | "report"; byKey: string };
  votes: Record<string, string | null>;
  ejected: string | null;
  ejectedRole: "crew" | "imposter" | null;
  playerLine: string | null;
  /** Utterances per agent key this meeting — drives fair speaker rotation. */
  spoken: Map<string, number>;
  /** When the next agent turn is due; the discussion runs the full timer. */
  turnAt: number;
  /** Last agent who spoke, so the same voice rarely repeats. */
  lastSpeaker: string | null;
  /** Index into `messages` where this meeting's transcript begins. */
  msgStart: number;
  /**
   * `speaker|kind|about` keys already applied this meeting, so one traitor
   * repeating the same accusation cannot stack the same belief repeatedly.
   */
  claimsApplied: Set<string>;
  /** The one agent allowed to speak right now, or null between turns. */
  speaker: SpeakerToken | null;
  /** Monotonic per-meeting turn id, handed out with each token. */
  speakerSeq: number;
}

export interface SpeakerView {
  key: string;
  name: string;
  color: string;
  isPlayer: boolean;
  alive: boolean;
  hasSpoken: boolean;
  voted: boolean;
}

export interface RevealedVote {
  key: string;
  name: string;
  targetName: string | null;
}

export interface MeetingView {
  stage: "discussion" | "voting" | "tally";
  secondsLeft: number;
  /** The single agent holding the speaking token, or null between turns. */
  speaking: string | null;
  reason: string;
  messages: ChatMessage[];
  speakers: SpeakerView[];
  myVote: string | null;
  votesRevealed: boolean;
  revealedVotes: RevealedVote[];
  ejection: { name: string; isImposter: boolean } | null;
}

/** One imposter's true identity, published once the match is over. */
export interface ImposterReveal {
  key: string;
  name: string;
  color: string;
}

export interface Snapshot {
  phase: Phase;
  winner: Winner;
  time: number;
  /** The imposters' true identities once the verdict lands, else null. */
  reveal: ImposterReveal[] | null;
  role: "crew" | "imposter";
  playerName: string;
  playerAlive: boolean;
  taskProgress: number;
  tasks: { poiId: string; label: string; room: string; done: boolean }[];
  prompt: string | null;
  killCooldown: number;
  sabotageCooldown: number;
  sabotage: {
    kind: SabotageKind;
    secondsLeft: number;
    /** Total length of this sabotage, so the UI can draw a countdown. */
    duration: number;
    fixPoiId: string;
    fixProgress: number;
    /**
     * Every repair point and whether someone is currently holding it. The
     * reactor needs both scanners held at once, so the HUD uses this to show
     * which pad still needs a second pair of hands.
     */
    fixPois: { id: string; label: string; room: string; held: boolean }[];
  } | null;
  visionRange: number;
  bodies: number;
  alive: { crew: number; imposter: number };
  meeting: MeetingView | null;
  log: string[];
  llm: {
    enabled: boolean;
    configured: boolean;
    provider: LlmProvider | null;
    calls: number;
    fallbacks: number;
    budget: number;
    /** The model each AI agent is running on — deliberately all different. */
    roster: { key: string; name: string; model: string | null }[];
  };
  explored: number;
  meetings: number;
  ejects: number;
  analyst: { key: string; name: string; color: string; top: string; score: number }[] | null;
  activeTask: { poiId: string; label: string; room: string; kind: "wiring" | "calibration" } | null;
  /** True while the player has left the match to watch with full vision. */
  spectator: boolean;
  /** The agent thought feed, oldest first. */
  thoughts: ThoughtEntry[];
  /** The raw model replies behind the model-sourced decisions, oldest first. */
  rawJsons: RawJsonEntry[];
  /** The public station log the AI crew has written this match, oldest first. */
  stationLog: StationLogEntry[];
  /** Per-agent private thoughts, oldest first. Spoilers: see `Confessional`. */
  confessional: ConfessionalEntry[];
  /** The ghost channel transcript, oldest first. Dead-only; a spoiler. */
  ghostChat: ChatMessage[];
  /** Lifetime ghost lines, surviving the ring buffer. */
  ghostMessages: number;
  /** The single ghost holding the channel right now, or null while it is quiet. */
  ghostSpeaker: string | null;
  /** Every declared communication channel and its audience. */
  channels: ChannelDef[];
  /** Cross-match reputations and grudges, or null when the ledger is off. */
  legacy: LegacyView | null;
  /**
   * The structured timeline so far — the same append-only beats the recap is
   * built from. The broadcast layer reads it to narrate the shift live, so
   * every on-screen call-out comes from a real event rather than from prose
   * parsed back out of the chat.
   */
  events: MatchEvent[];
}

export interface EngineOptions {
  map?: GameMap;
  seed?: number;
  playerIsImposter?: boolean;
  llm?: boolean;
  /** Skip the cross-match ledger (tests, replays, deterministic replays). */
  legacy?: boolean;
  /**
   * Bring a ledger with you instead of reading `localStorage`. The match host
   * uses this so every autonomous shift folds into one server-side ledger that
   * survives restarts, while browser-local runs keep reading storage as before.
   */
  legacyLedger?: LegacyLedger;
  /**
   * The models that were imposters in the *previous* shift. The new roster
   * avoids them when the pool is deep enough, so back-to-back matches open
   * with different AIs holding the knife.
   */
  imposterAvoid?: readonly string[];
}

/** What the UI needs to show who has history with whom. */
export interface LegacyView {
  shifts: number;
  agents: {
    name: string;
    games: number;
    wins: number;
    eliminations: number;
    /** Names this agent opens the shift already distrusting. */
    grudges: string[];
  }[];
}

/** Which models play which side this shift. */
export interface SeatModelDraw {
  /** The models cast as imposters this shift. */
  imposters: string[];
  /** The rest of the pool, cast as honest crew. */
  crew: string[];
}

/**
 * Draw this shift's cast from a provider's model pool.
 *
 * `imposterCount` models are picked at random to hold the knife and the rest
 * run crew, so a traitor model never also plays an honest crewmate *within* a
 * match — but any model can be a traitor *across* matches, which is what makes
 * the roles worth watching. `avoid` names the previous shift's traitors: when
 * the pool is deep enough the draw never repeats them, so no two shifts in a
 * row open with the same pair under the knife.
 *
 * The draw is seeded, so a replayed shift re-casts the same roles; it runs on
 * its own rng stream, separate from the simulation's, so casting never
 * disturbs the deterministic sequence `scripts/simulate.ts` replays.
 */
export function drawSeatModels(
  pool: readonly string[],
  imposterCount: number,
  avoid: readonly string[] = [],
  seed = 1,
): SeatModelDraw {
  if (pool.length === 0) return { imposters: [], crew: [] };

  // When avoiding previous impostors, the draw must vary even with the same
  // seed — otherwise shifts alternate between the same two pairs. Mix the
  // avoid list into the seed so each shift's draw is genuinely different.
  let effectiveSeed = seed >>> 0;
  for (let i = 0; i < avoid.length; i++) {
    effectiveSeed = Math.imul(effectiveSeed ^ avoid[i].length, 0x9e3779b9) >>> 0;
    effectiveSeed ^= (effectiveSeed << 13) >>> 0;
  }
  effectiveSeed = (effectiveSeed ^ 0x51ed270b) >>> 0;
  
  const cast = makeRng(effectiveSeed);
  const order = [...pool];
  for (let i = order.length - 1; i > 0; i--) {
    const j = cast.int(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }

  const fresh = order.filter((m) => !avoid.includes(m));
  // Too small a pool to dodge last shift's traitors? Draw from everyone.
  const source = fresh.length >= imposterCount ? fresh : order;
  const imposters = source.slice(0, Math.max(0, Math.min(imposterCount, source.length)));
  const crew = order.filter((m) => !imposters.includes(m));
  // A one-model pool (Berget) plays every role, as it always has.
  return { imposters, crew: crew.length > 0 ? crew : [...pool] };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class GameEngine {
  readonly map: GameMap;
  readonly grid: NavGrid;
  /** The spatial zone graph every actor is located within. */
  readonly zones: ZoneGraph;
  readonly vis: VisibilityGrid;
  private readonly los: (ax: number, ay: number, bx: number, by: number) => boolean;
  private readonly rng: Rng;
  /** The seed this shift was built from — drives the role draw as well. */
  private readonly matchSeed: number;
  /** Models the previous shift cast as imposters; this shift avoids them. */
  private readonly imposterAvoid: readonly string[];
  /** This shift's traitor models, drawn at random from the provider pool. */
  private imposterSeatModels: string[] = [];
  /** This shift's crew models — the pool minus whoever drew the knife. */
  private crewSeatModels: string[] = [];

  player!: Player;
  crewmates: Crewmate[] = [];
  imposters: Imposter[] = [];
  actors: Actor[] = [];

  phase: Phase = "briefing";
  winner: Winner = null;
  time = 0;
  startedAt = Date.now();

  bodies: Body[] = [];
  private nextBodyId = 1;
  private nextMsgId = 1;

  taskTotal = 0;
  taskComplete = 0;
  playerTasks: TaskAssignment[] = [];

  meeting: Meeting | null = null;
  meetingsHeld = 0;
  ejects = 0;
  /** The imposters' true identities, published by the end-of-match reveal. */
  reveal: ImposterReveal[] | null = null;
  /** How many AI agents have been told the imposter identities. */
  private revealedTo = 0;
  /** Turns granted the speaking token this match — one voice at a time. */
  private meetingSpeakerTurns = 0;
  /** Attempts to speak without holding the token (must stay 0). */
  private meetingSpeakerViolations = 0;
  /** Turns granted while another was already live (must stay 0). */
  private meetingSpeakerOverlaps = 0;

  sabotage: { kind: SabotageKind; secondsLeft: number; fixPoiIds: string[]; fixProgress: number } | null = null;
  sabotageCooldown = 0;
  /** Emergency beacon lockout after a meeting, so respawns can't chain them. */
  emergencyCooldown = 0;

  keys = new Set<string>();
  /** Analog movement vector from the on-screen joystick (touch devices). */
  touchMove: MoveInput | null = null;
  log: string[] = [];
  messages: ChatMessage[] = [];
  /** The ghost channel: the dead AIs talking among themselves; the living never hear it. */
  ghostChat: ChatMessage[] = [];
  /** The one ghost currently holding the channel, or null while it is quiet. */
  private ghostSpeaker: string | null = null;
  /** When the current speaker's turn ends and the channel frees up. */
  private ghostSpeakerUntil = 0;
  /** When the next ghost may begin. */
  private ghostTurnAt = 0;
  /** Round-robin cursor over the dead, so every ghost gets a turn. */
  private ghostTurn = 0;
  /** Lifetime ghost lines, kept across the ring buffer for audit. */
  private ghostSpoken = 0;

  analystView = false;
  /**
   * Spectator mode: the player has left the roster and watches with full
   * vision. Derived from the player's `status`, so it is the same fact as
   * `playerActor.status === "spectator"` rather than a parallel flag.
   */
  get spectator(): boolean {
    return this.playerActor.status === "spectator";
  }
  /** Agent thought feed (ring buffer, oldest first) for the UI. */
  thoughts: ThoughtEntry[] = [];
  private nextThoughtId = 1;
  /** Raw model replies (oldest first) for the feed's JSON log. */
  rawJsons: RawJsonEntry[] = [];
  private nextRawId = 1;
  /** Raw reply of an agent's most recent model decision, consumed by its UI row. */
  private lastRawByKey: Map<string, string> = new Map();

  /** The public station log: what the AI crew has written at generative consoles. */
  stationLog: StationLogEntry[] = [];
  private nextLogId = 1;
  /** Log entries produced by a live model, so the extra calls stay capped. */
  private logModelCalls = 0;
  /** Consoles that have already produced a log entry this match. */
  private loggedConsoles = new Set<string>();
  /** Per-agent private thoughts (the confessional), oldest first. */
  confessional: ConfessionalEntry[] = [];
  private nextConfessionalId = 1;

  /** Cross-match ledger, and the grudges each agent opened this shift with. */
  private legacy: LegacyLedger | null = null;
  private legacyEnabled: boolean;
  private grudgesByKey: Map<string, string[]> = new Map();
  /** Every ejection this match with its voters, for the end-of-match fold. */
  private ejections: LegacyEjection[] = [];
  /**
   * The structured timeline of this match (kills, sabotage, meetings, ejects,
   * the verdict). Append-only; drives the end-of-match recap. See `events.ts`.
   */
  events: MatchEvent[] = [];

  /** Ring-buffer a raw model reply for the feed, tagged with its speaker. */
  private pushRawJson(a: Actor, raw: string): void {
    this.rawJsons.push({
      id: this.nextRawId++,
      t: this.time,
      key: a.key,
      name: a.name,
      color: a.color,
      text: raw.length > 400 ? `${raw.slice(0, 400)}…` : raw,
    });
    if (this.rawJsons.length > RAW_JSON_MAX) this.rawJsons.shift();
  }
  llmEnabled: boolean;
  /** Set by the UI so the match can be written to history when it ends. */
  onMatchEnd: ((winner: "crew" | "imposter") => void) | null = null;
  /** Task console the human has opened but not finished yet. */
  activeTask: TaskAssignment | null = null;
  llmCalls = 0;
  llmFallbacks = 0;

  private readonly provider: ProviderConfig | null;
  /** Shared throttle + spend guard. Each actor supplies its own `cfg`. */
  private readonly ai: AiContext;
  private perceptionAcc = 0;

  /**
   * Display name per provider, used when no model is configured: agents still
   * introduce themselves as the AI they are rather than a fictional alias.
   */
  private readonly AGENT_MODEL_NAMES: Record<LlmProvider, string> = {
    pollinations: "POLLINATIONS",
    berget: "BERGET",
  };

  constructor(opts: EngineOptions = {}) {
    this.map = opts.map ?? DEFAULT_MAP;
    this.grid = buildNavGrid(this.map);
    this.zones = buildZoneGraph(this.map);
    this.vis = buildVisibilityGrid(this.map);
    this.los = makeLosTest(this.map);
    this.matchSeed = opts.seed ?? 20260410;
    this.rng = makeRng(this.matchSeed);
    this.imposterAvoid = [...(opts.imposterAvoid ?? [])];
    this.llmEnabled = opts.llm ?? true;
    this.provider = activeProvider();
    this.ai = { cfg: null, gate: new RequestGate(300, 3), budget: { remaining: LLM_BUDGET } };
    // The cross-match ledger is read once, here, so the roster can open the
    // shift already carrying last shift's grudges. Headless runs (no storage)
    // simply get an empty ledger and the seeding becomes a no-op.
    this.legacyEnabled = opts.legacy ?? true;
    this.legacy = this.legacyEnabled
      ? (opts.legacyLedger ?? loadLegacy())
      : null;

    this.buildRoster(opts.playerIsImposter ?? false);
  }

  // -- setup ---------------------------------------------------------------

  private buildRoster(playerIsImposter: boolean): void {
    const playerRole: "crew" | "imposter" = playerIsImposter ? "imposter" : "crew";
    this.player = createPlayer(this.map, playerIsImposter ? "#ff5a6e" : "#38e1c8");

    this.crewmates = createCrewmates(this.map, AI_CREW, 7);
    this.imposters = createImposters(this.map, playerIsImposter ? 1 : 2, 101);

    const spawn = this.map.pointsOfInterest.find((p) => p.kind === "spawn");
    const sx = spawn?.x ?? 840;
    const sy = spawn?.y ?? 340;

    // Everything starts around the meeting table so no one spawns inside a wall.
    const seatAll = [...this.crewmates, ...this.imposters];
    seatAll.forEach((e, i) => {
      const p = this.seatAt(sx, sy, i, seatAll.length + 1, e.radius);
      e.x = p.x;
      e.y = p.y;
    });
    const playerSeat = this.seatAt(sx, sy, seatAll.length, seatAll.length + 1, this.player.radius);
    this.player.x = playerSeat.x;
    this.player.y = playerSeat.y;

    const imposterKeys = this.imposters.map((_, i) => `imp:${i}`);

    // Cast this shift's roles before any name is derived: which models wear
    // the knife is a fresh random draw every match.
    this.pickSeatModels(this.imposters.length);

    // AI agents are named for the model that runs them. If the provider's
    // pool is smaller than the roster (Berget has a single model), repeats
    // get a number so every agent stays uniquely addressable in prompts.
    const aiNames: string[] = [];
    const seenNames = new Map<string, number>();
    const pushName = (base: string): void => {
      const seen = (seenNames.get(base) ?? 0) + 1;
      seenNames.set(base, seen);
      aiNames.push(seen === 1 ? base : `${base}-${seen}`);
    };
    for (let i = 0; i < this.crewmates.length; i++) {
      pushName(this.agentDisplayName("crew", i));
    }
    for (let i = 0; i < this.imposters.length; i++) {
      pushName(this.agentDisplayName("imposter", i));
    }

    const playerMind = createMind("player", playerRole, playerIsImposter ? imposterKeys : []);

    this.actors = [
      {
        key: "player",
        name: "ORION",
        color: this.player.color,
        role: playerRole,
        kind: "player",
        isPlayer: true,
        status: "alive",
        get alive(): boolean {
          return isParticipating(this.status);
        },
        zoneId: "",
        entity: this.player,
        mind: playerMind,
        cfg: null,
        tasks: [],
        processed: 0,
        counted: 0,
        nextDecisionAt: 0,
        decisionSeq: 0,
        pendingDecision: false,
        urgencyAt: 0,
        actionFeedback: null,
        bodyToReport: null,
        deceptionStyle: null,
        repathAt: 0,
        killCooldown: 0,
        fixUntil: 0,
        voteAt: 0,
      },
      ...this.crewmates.map((e, i) => {
        // The entity's name drives the canvas label, so rename the entity
        // itself and keep every surface (render, transcripts, prompts) on the
        // same model-derived name.
        e.name = aiNames[i];
        return this.makeActor(`crew:${i}`, e, "crew", i, aiNames[i]);
      }),
      ...this.imposters.map((e, i) => {
        const name = aiNames[this.crewmates.length + i];
        e.name = name;
        return this.makeActor(`imp:${i}`, e, "imposter", i, name);
      }),
    ];

    // Imposters know each other; that secrecy is what makes them dangerous.
    const allies = this.actors.filter((a) => a.role === "imposter").map((a) => a.key);
    for (const a of this.actors) {
      if (a.role === "imposter") a.mind.allies = allies.filter((k) => k !== a.key);
    }

    // --- cross-match memory ---------------------------------------------
    // Each AI walks in already distrusting whoever wronged it last shift. This
    // runs after allies are set (a traitor never distrusts its partner) and
    // before any perception, so a grudge is something the agent *brought* to
    // the deck rather than something the match told it.
    this.grudgesByKey.clear();
    if (this.legacy) {
      const roster = this.actors.map((a) => ({ key: a.key, name: this.identityOf(a) }));
      for (const a of this.actors) {
        if (a.isPlayer) continue;
        const grudges = seedGrudges(a.mind, this.identityOf(a), this.legacy, roster);
        if (grudges.length > 0) this.grudgesByKey.set(a.key, grudges);
      }
    }

    if (playerRole === "crew") {
      this.playerTasks = assignTasks(this.map, AI_CREW);
      this.actors[0].tasks = this.playerTasks;
    }

    // Every crewmate — the human included — is handed the same shape from the
    // docs' task pools: SHORT_TASKS_PER_CREW quick tasks plus
    // LONG_TASKS_PER_CREW long ones. The slots rotate, but with seven tasks a
    // head the pools are necessarily shared (as they are in real Among Us), so
    // crewmates do cross paths on the way to the same consoles.
    let crewSlot = 0;
    this.actors.forEach((a) => {
      if (a.kind === "crew") a.tasks = assignTasks(this.map, crewSlot++);
    });

    this.taskTotal =
      (playerRole === "crew" ? PLAYER_TASKS : 0) + AI_CREW * TASKS_PER_CREW;

    revealAround(this.vis, this.player.x, this.player.y, 260);
    this.refreshZones();
    this.note("Role assigned. Deck K7 is live.");
  }

  /** Recompute every living actor's zone from its world position. */
  private refreshZones(): void {
    for (const a of this.actors) {
      if (!a.alive) continue;
      a.zoneId = zoneAtPoint(this.zones, this.map, a.entity.x, a.entity.y).id;
    }
  }

  /**
   * Find a seat around `(cx, cy)` that an agent can genuinely stand in.
   * A naive ring overruns the meeting table's room and parks half the roster
   * in the wall, where they would be stuck forever.
   */
  private seatAt(
    cx: number,
    cy: number,
    index: number,
    count: number,
    radius: number,
  ): { x: number; y: number } {
    const beacon = this.map.pointsOfInterest.find((p) => p.kind === "emergency");
    const base = (index / Math.max(1, count)) * Math.PI * 2;
    const clearOfBeacon = (x: number, y: number): boolean =>
      !beacon || Math.hypot(x - beacon.x, y - beacon.y) > 88;

    for (let ring = 1; ring <= 8; ring++) {
      const rx = 30 * ring;
      const ry = 22 * ring;
      for (let k = 0; k < 8; k++) {
        const a = base + (k / 8) * (Math.PI * 2);
        const x = cx + Math.cos(a) * rx;
        const y = cy + Math.sin(a) * ry;
        if (canStand(this.map, x, y, radius) && clearOfBeacon(x, y)) return { x, y };
      }
    }
    return nearestStandable(this.map, cx, cy, radius);
  }

  private makeActor(
    key: string,
    entity: Crewmate | Imposter,
    role: "crew" | "imposter",
    index: number,
    displayName: string,
  ): Actor {
    return {
      key,
      name: displayName,
      color: entity.color,
      role,
      kind: role === "crew" ? "crew" : "imposter",
      isPlayer: false,
      status: "alive",
      get alive(): boolean {
        return isParticipating(this.status);
      },
      zoneId: "",
      entity,
      mind: createMind(key, role),
      cfg: this.modelFor(index, role),
      tasks: [],
      processed: 0,
      counted: 0,
      nextDecisionAt: 1 + this.rng.range(0, 4),
      decisionSeq: 0,
      pendingDecision: false,
      urgencyAt: 0,
      actionFeedback: null,
      bodyToReport: null,
      deceptionStyle: role === "imposter" ? styleForIndex(index) : null,
      repathAt: 0,
      killCooldown: role === "imposter" ? 34 : 0,
      fixUntil: 0,
      voteAt: 0,
    };
  }

  /**
   * Draw this shift's cast from the provider's pool: `imposterCount` models
   * are picked at random to be the traitors, the rest run crew — so a traitor
   * model never also plays an honest crewmate *within* a match, but any model
   * can be a traitor *across* matches. The draw avoids last shift's traitors
   * whenever the pool is deep enough, so no two shifts in a row open with the
   * same pair under the knife.
   *
   * It runs on its own rng stream seeded off the match seed, so casting the
   * roles never disturbs the deterministic sequence the simulation replays.
   */
  private pickSeatModels(imposterCount: number): void {
    const draw = drawSeatModels(
      this.provider?.models ?? [],
      imposterCount,
      this.imposterAvoid,
      this.matchSeed,
    );
    this.imposterSeatModels = draw.imposters;
    this.crewSeatModels = draw.crew;
  }

  /**
   * Bind agent `index` of `role` to its own model from this shift's cast.
   * Crew and imposter seats draw from disjoint lists (a traitor model never
   * also plays honest crew in the same match); within a list the order is
   * walked in sequence and wrapped only if it runs short.
   */
  private modelFor(
    index: number,
    role: "crew" | "imposter" = "crew",
  ): LlmConfig | null {
    if (!this.provider) return null;
    const pool = role === "imposter" ? this.imposterSeatModels : this.crewSeatModels;
    if (pool.length === 0) return null;
    return configFor(this.provider, pool[index % pool.length]);
  }

  /**
   * Display name for an agent: the model that actually runs it, rendered as a
   * readable name ("Minimax M3") rather than the raw provider/model ID.
   */
  private modelNameOf(cfg: LlmConfig | null): string {
    if (cfg?.model) {
      return modelDisplayName(cfg.model) || this.AGENT_MODEL_NAMES[cfg.provider];
    }
    return this.AGENT_MODEL_NAMES.pollinations;
  }

  /**
   * Display name for a roster slot: the model that runs that agent. With no
   * provider configured (pure heuristic mode) there is no model name, so
   * agents are simply numbered AI-1, AI-2, …
   */
  private agentDisplayName(role: "crew" | "imposter", index: number): string {
    const cfg = this.modelFor(index, role);
    if (!cfg) return `AI-${index + 1}`;
    return this.modelNameOf(cfg);
  }

  /** Per-agent decision context: its own endpoint, the shared gate and budget. */
  private contextFor(a: Actor): AiContext {
    return {
      cfg: a.cfg,
      gate: this.ai.gate,
      budget: this.ai.budget,
      // Each in-flight call gets its own context, so stashing the raw reply
      // under the actor's key cannot cross wires between concurrent calls.
      onRaw: (raw) => {
        this.lastRawByKey.set(a.key, raw);
        this.pushRawJson(a, raw);
      },
    };
  }

  // -- lookup helpers ------------------------------------------------------

  get playerActor(): Actor {
    return this.actors[0];
  }

  actor(key: string): Actor | undefined {
    return this.actors.find((a) => a.key === key);
  }

  get names(): NameIndex {
    const out: NameIndex = {};
    for (const a of this.actors) out[a.key] = a.name;
    return out;
  }

  get visionRange(): number {
    return this.sabotage?.kind === "blackout" ? BLACKOUT_VISION : BASE_VISION;
  }

  living(role?: "crew" | "imposter"): Actor[] {
    return this.actors.filter((a) => isParticipating(a.status) && (!role || a.role === role));
  }

  /** Lifetime ghost lines this match (not capped by the transcript ring). */
  get ghostMessages(): number {
    return this.ghostSpoken;
  }

  /** Meeting turns granted the speaking token (audit: one voice at a time). */
  get speakerTurns(): number {
    return this.meetingSpeakerTurns;
  }

  /** Attempts to speak without the token — always 0 when the gate holds. */
  get speakerViolations(): number {
    return this.meetingSpeakerViolations;
  }

  /** How many AI agents the end-of-match reveal has informed (0 before it). */
  get revealedAgents(): number {
    return this.revealedTo;
  }

  /** Turns granted while another was already live — always 0. */
  get speakerOverlaps(): number {
    return this.meetingSpeakerOverlaps;
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 6) this.log.shift();
  }

  /**
   * The single write path for chat. The channel's descriptor decides where a
   * message lands (the public transcript or the ghost channel) and how many
   * entries are retained, so adding a lane never means adding a store.
   */
  private publish(channel: ChannelId, msg: Omit<ChatMessage, "channel">): void {
    const def = CHANNELS[channel];
    const target = def.audience === "dead" ? this.ghostChat : this.messages;
    target.push({ ...msg, channel });
    if (def.retention > 0 && target.length > def.retention) {
      target.splice(0, target.length - def.retention);
    }
  }

  private say(a: Actor, text: string, kind: ChatMessage["kind"] = "statement"): void {
    this.publish("meeting", {
      id: this.nextMsgId++,
      t: this.time,
      speakerKey: a.key,
      speakerName: a.name,
      color: a.color,
      text,
      kind,
    });
  }

  /** A ghost line: dead-only, candid, and never a belief input for the living. */
  private ghostSay(a: Actor, text: string): void {
    this.publish("ghost", {
      id: this.nextMsgId++,
      t: this.time,
      speakerKey: a.key,
      speakerName: a.name,
      color: a.color,
      text,
      kind: "ghost",
    });
  }

  private system(text: string): void {
    this.publish("system", {
      id: this.nextMsgId++,
      t: this.time,
      speakerKey: "system",
      speakerName: "STATION",
      color: "#ffb020",
      text,
      kind: "system",
    });
    this.note(text);
  }

  // -- public control ------------------------------------------------------

  setKey(key: string, down: boolean): void {
    if (down && this.spectator) return;
    if (down) this.keys.add(key);
    else this.keys.delete(key);
  }

  /**
   * Keyboard wins while a movement key is held; otherwise the touch
   * joystick's analog vector is used so both inputs can coexist.
   */
  private moveInput(): MoveInput {
    const keys = inputVectorFromKeys(this.keys);
    if (keys.x !== 0 || keys.y !== 0) return keys;
    return this.touchMove ?? keys;
  }

  /**
   * Start the match. Pass `spectate` to sit the match out entirely: the player
   * leaves the roster (reusing the dead-player rules) and watches the AI play
   * with the whole deck visible.
   */
  begin(spectate = false): void {
    if (this.phase !== "briefing") return;
    this.phase = "playing";
    this.startedAt = Date.now();
    this.system("Match started — find the imposters or finish the tasks.");
    if (spectate) this.enterSpectator();
  }

  /**
   * Spectator mode: one-way per match. The player departs the living roster —
   * which is exactly the dead-player path — so every existing rule applies for
   * free: no kill target, no witness, no sightings, no meeting seat, no task
   * credit and no win-count weight. Only the input/interaction guards below
   * and the renderer's fog gate (full vision) are spectator-specific.
   */
  enterSpectator(): void {
    if (this.spectator || this.phase === "ended") return;
    const me = this.playerActor;
    // Departing the roster is the same status transition as death, so every
    // existing rule applies for free: no kill target, no witness, no
    // sightings, no meeting seat and no task credit. `setActorStatus` also
    // frees the player's input and recounts the task bar without its quota.
    this.setActorStatus(me, "spectator");
    const ended = this.checkWin();
    if (!ended) {
      this.note("You left the match — spectating with full deck vision.");
    }
  }

  /**
   * The one place an actor's participation status changes.
   *
   * `status` is the single source of truth (`Actor.alive` is derived from it),
   * so this owns every mechanical side effect of a change: a departing AI body
   * is halted and pulled off the deck, the player gives up held input and any
   * open task, and the shared task bar is recounted so the remaining crew can
   * still reach it.
   *
   * Win evaluation is deliberately *not* part of this transition: `resolveVote`
   * defers `checkWin()` to `finishMeeting` so the tally screen and the meeting
   * memories land before the verdict, and the other callers ask for it
   * themselves.
   */
  private setActorStatus(a: Actor, next: ActorStatus): void {
    if (a.status === next) return;
    const wasParticipating = isParticipating(a.status);
    a.status = next;

    if (!isParticipating(next) && a.kind !== "player") {
      // Pull a departing AI body off the deck: nothing may draw, target or
      // collide with a corpse.
      if (a.kind === "crew") {
        const c = a.entity as Crewmate;
        crewmateHalt(c);
        c.x = -9999;
        c.y = -9999;
      } else {
        const i = a.entity as Imposter;
        imposterHalt(i);
        i.x = -9999;
        i.y = -9999;
      }
    }

    // The player leaving the roster gives up held input and any open task. A
    // *dead* player is left exactly as it was, matching the previous behaviour.
    if (a.isPlayer && (next === "spectator" || next === "disconnected")) {
      this.keys.clear();
      this.touchMove = null;
      this.activeTask = null;
    }

    if (wasParticipating) this.syncTaskBudget();
  }

  // -- perception ----------------------------------------------------------

  private visible(observer: Actor, tx: number, ty: number): boolean {
    if (!observer.alive) return false;
    const d = Math.hypot(tx - observer.entity.x, ty - observer.entity.y);
    if (d > this.visionRange) return false;
    return this.los(observer.entity.x, observer.entity.y, tx, ty);
  }

  private perceive(dt: number): void {
    this.perceptionAcc += dt;
    if (this.perceptionAcc < 0.1) return;
    this.perceptionAcc = 0;
    const t = this.time;

    for (const obs of this.actors) {
      if (!obs.alive) continue;
      for (const tgt of this.actors) {
        if (tgt === obs || !tgt.alive) continue;
        if (!this.visible(obs, tgt.entity.x, tgt.entity.y)) continue;

        const room = roomAt(this.map, tgt.entity.x, tgt.entity.y);
        // Remember where everyone went for the whole match: log a sighting only
        // the first time this agent places a target in a new room, so the full
        // movement history survives without a per-0.1s flood of duplicates.
        const prevSeen = obs.mind.lastSeen[tgt.key];
        if (!prevSeen || prevSeen.roomId !== room.id) {
          remember(obs.mind, {
            t,
            kind: "sighted",
            actorKey: tgt.key,
            roomId: room.id,
            text: `Saw ${tgt.name} in ${room.name}.`,
          });
        }
        noteSighting(obs.mind, tgt.key, room.id, tgt.entity.x, tgt.entity.y, t);

        // Watching someone climb into a vent is the strongest possible tell —
        // but only the act itself counts: an imposter merely walking or standing
        // near a grate is doing nothing wrong, so proximity alone must never
        // brand them. Catch the climb-in (seeking_vent at the grate) or the
        // imposter sitting in the pipe (venting).
        if (tgt.role === "imposter" && !obs.mind.ventsSeen.has(tgt.key)) {
          const imp = tgt.entity as Imposter;
          const vent = nearestPoi(this.map, "vent", tgt.entity.x, tgt.entity.y);
          const atGrate =
            vent !== null && Math.hypot(vent.x - tgt.entity.x, vent.y - tgt.entity.y) < 30;
          if ((imp.state === "venting" || (imp.state === "seeking_vent" && atGrate))) {
            obs.mind.ventsSeen.add(tgt.key);
            remember(obs.mind, {
              t,
              kind: "vent",
              actorKey: tgt.key,
              roomId: room.id,
              text: `${tgt.name} used a vent in ${room.name}.`,
            });
          }
        }
      }

      for (const b of this.bodies) {
        if (obs.mind.bodiesSeen.has(b.id)) continue;
        if (!this.visible(obs, b.x, b.y)) continue;
        const bodyRoom = roomAt(this.map, b.x, b.y);
        obs.mind.bodiesSeen.add(b.id);
        remember(obs.mind, {
          t,
          kind: "body",
          actorKey: b.key,
          roomId: b.roomId,
          text: `Found ${b.name}'s body in ${bodyRoom.name}.`,
        });

        // Someone loitering over the corpse is remembered as an incriminating
        // circumstance; the belief follows from the memory, not from an
        // engine-side score.
        for (const other of this.actors) {
          if (other === obs || !other.alive) continue;
          if (Math.hypot(other.entity.x - b.x, other.entity.y - b.y) > 80) continue;
          if (!this.los(b.x, b.y, other.entity.x, other.entity.y)) continue;
          remember(obs.mind, {
            t,
            kind: "flag",
            actorKey: other.key,
            roomId: b.roomId,
            text: `${other.name} was standing right next to the body when I found it.`,
          });
        }

        // Inference, not observation: whoever this agent last saw in this room
        // shortly before the discovery is a lead worth remembering as-is; the
        // agent weighs it when it reasons.
        for (const [key, seen] of Object.entries(obs.mind.lastSeen)) {
          if (key === obs.key || key === b.key) continue;
          if (seen.roomId !== b.roomId) continue;
          if (t - seen.t > 60) continue;
          const seenName = this.names[key] ?? key;
          remember(obs.mind, {
            t,
            kind: "flag",
            actorKey: key,
            roomId: b.roomId,
            text: `The last place I saw ${seenName} was ${bodyRoom.name}, before I found the body.`,
          });
        }

        if (!obs.isPlayer && obs.role === "crew") {
          obs.bodyToReport = b.id;
          obs.repathAt = 0;
        }
      }

      decay(obs.mind, dt);
    }
  }

  // -- kills ---------------------------------------------------------------

  /** Anyone close enough to have seen `killer` at this moment. */
  witnesses(killer: Actor, exclude?: Actor, range = KILL_WITNESS_RANGE): Actor[] {
    const out: Actor[] = [];
    for (const a of this.actors) {
      if (a === killer || a === exclude || !a.alive) continue;
      // A fellow traitor watching is not an obstacle — they are in it together.
      if (a.role === killer.role) continue;
      if (Math.hypot(a.entity.x - killer.entity.x, a.entity.y - killer.entity.y) > range) {
        continue;
      }
      if (!this.visible(a, killer.entity.x, killer.entity.y)) continue;
      out.push(a);
    }
    return out;
  }

  private kill(killer: Actor, victim: Actor): boolean {
    if (!killer.alive || !victim.alive || killer.role !== "imposter" || victim.role !== "crew") {
      return false;
    }
    const d = Math.hypot(killer.entity.x - victim.entity.x, killer.entity.y - victim.entity.y);
    if (d > KILL_RANGE) return false;

    const witnesses = this.witnesses(killer, victim);

    // Capture the scene *before* the corpse is pulled off the map.
    const vx = victim.entity.x;
    const vy = victim.entity.y;
    const roomId = roomAt(this.map, vx, vy).id;

    this.setActorStatus(victim, "dead");
    killer.killCooldown = KILL_COOLDOWN;

    const body: Body = {
      id: this.nextBodyId++,
      key: victim.key,
      name: victim.name,
      color: victim.color,
      x: vx,
      y: vy,
      roomId,
    };
    this.bodies.push(body);
    const victimRoom = roomAt(this.map, vx, vy).name;
    this.system(`${victim.name} was killed in ${victimRoom}.`);
    this.events.push({
      kind: "kill",
      t: this.time,
      killerKey: killer.key,
      killerName: killer.name,
      victimKey: victim.key,
      victimName: victim.name,
      roomName: victimRoom,
      witnessed: witnesses.length > 0,
    });

    for (const w of witnesses) {
      remember(w.mind, {
        t: this.time,
        kind: "kill",
        actorKey: killer.key,
        roomId,
        text: `Watched ${killer.name} kill ${victim.name}.`,
      });
      if (!w.isPlayer && w.role === "crew") {
        w.bodyToReport = body.id;
        w.repathAt = 0;
      }
    }

    if (victim.isPlayer) this.note("You are dead — spectate and watch the others.");
    this.checkWin();
    return true;
  }

  canPlayerKill(): boolean {
    const me = this.playerActor;
    if (!me.alive || me.role !== "imposter" || this.phase !== "playing") return false;
    if (me.killCooldown > 0) return false;
    return this.killTargetFor(me) !== null;
  }

  /** Public so the HUD and the headless scripts can ask the same question. */
  killTargetFor(me: Actor): Actor | null {
    const candidates = this.living("crew")
      .filter((a) => a !== me)
      .map((a) => ({ a, d: Math.hypot(a.entity.x - me.entity.x, a.entity.y - me.entity.y) }))
      .filter((c) => c.d < KILL_RANGE)
      .sort((x, y) => x.d - y.d);

    for (const c of candidates) {
      // The victim is not a witness to their own murder — pass them in.
      if (this.witnesses(me, c.a).length === 0) return c.a;
    }
    return null;
  }

  playerKill(): boolean {
    const me = this.playerActor;
    const target = this.killTargetFor(me);
    if (!target) return false;
    return this.kill(me, target);
  }

  // -- sabotage ------------------------------------------------------------

  triggerSabotage(kind?: SabotageKind): boolean {
    if (this.phase !== "playing" || this.sabotage || this.sabotageCooldown > 0) return false;
    if (!this.playerActor.alive) return false;
    const chosen: SabotageKind =
      kind ?? (this.rng.chance(0.5) ? "meltdown" : "blackout");

    if (chosen === "meltdown") {
      this.sabotage = {
        kind: "meltdown",
        secondsLeft: MELTDOWN_TIME,
        fixPoiIds: ["sab_hand_n", "sab_hand_s"],
        fixProgress: 0,
      };
      this.system("SABOTAGE: reactor meltdown — hold BOTH hand scanners in Reactor at once.");
    } else {
      this.sabotage = {
        kind: "blackout",
        secondsLeft: BLACKOUT_TIME,
        fixPoiIds: ["sab_lights"],
        fixProgress: 0,
      };
      this.system("SABOTAGE: lights out — repair the panel in Electrical.");
    }
    this.sabotageCooldown = SABOTAGE_COOLDOWN;
    this.events.push({ kind: "sabotage", t: this.time, sabotage: chosen });
    // Station-wide alarm: every crewmate reconsiders right away instead of
    // sleeping through the first half of the countdown in its decision lull.
    for (const a of this.actors) {
      if (a.isPlayer || !a.alive || a.kind !== "crew") continue;
      a.nextDecisionAt = Math.min(a.nextDecisionAt, this.time + this.rng.range(0.5, 2));
    }
    return true;
  }

  /**
   * Who is actively holding each live repair point right now. A pad is held
   * only by someone deliberately working it — the human is holding `e`, an AI
   * is inside the `fixUntil` window it won when it chose FIX — and anyone alive
   * can do it, because in Among Us both crewmates and impostors can resolve a
   * meltdown. Occupancy is tracked per pad: the reactor's two scanners must be
   * held *simultaneously*, so a single worker on either one is not enough.
   *
   * `exclude` drops one actor from the answer, which is what lets an agent ask
   * "is someone else already on this pad?" without counting itself.
   */
  private sabotageHolders(exclude?: Actor): Map<string, Actor[]> {
    const out = new Map<string, Actor[]>();
    if (!this.sabotage) return out;
    for (const id of this.sabotage.fixPoiIds) out.set(id, []);
    for (const a of this.actors) {
      if (!a.alive || a === exclude) continue;
      if (a.isPlayer) {
        if (!this.keys.has("e")) continue;
      } else if (a.fixUntil <= this.time) {
        // An AI only repairs after it has chosen and validated a FIX interaction.
        continue;
      }
      for (const id of this.sabotage.fixPoiIds) {
        const poi = this.map.pointsOfInterest.find((p) => p.id === id);
        if (!poi) continue;
        if (Math.hypot(poi.x - a.entity.x, poi.y - a.entity.y) <= INTERACT_RANGE) {
          out.get(id)!.push(a);
        }
      }
    }
    return out;
  }

  private updateSabotage(dt: number): void {
    if (this.sabotageCooldown > 0) this.sabotageCooldown = Math.max(0, this.sabotageCooldown - dt);
    if (this.emergencyCooldown > 0) {
      this.emergencyCooldown = Math.max(0, this.emergencyCooldown - dt);
    }
    if (!this.sabotage) return;

    this.sabotage.secondsLeft -= dt;

    const holders = this.sabotageHolders();
    const totalHolders = [...holders.values()].reduce((n, v) => n + v.length, 0);
    // Every pad has to be occupied *at the same time*. Lights has a single
    // console, so one worker is enough; the reactor's two scanners both need a
    // hand, which is what makes it require two people.
    const covered = this.sabotage.fixPoiIds.every(
      (id) => (holders.get(id)?.length ?? 0) > 0,
    );

    if (covered) {
      this.sabotage.fixProgress += dt * (1 + 0.4 * (totalHolders - 1));
      if (this.sabotage.fixProgress >= REPAIR_TIME) {
        const kind = this.sabotage.kind;
        this.sabotage = null;
        this.system(
          kind === "blackout"
            ? "Sabotage repaired — lights restored."
            : "Reactor sabotage repaired — the meltdown is stopped.",
        );
        this.events.push({ kind: "repair", t: this.time, sabotage: kind });
      }
    } else {
      this.sabotage.fixProgress = Math.max(0, this.sabotage.fixProgress - dt * 0.5);
    }

    if (this.sabotage && this.sabotage.secondsLeft <= 0) {
      const wasMeltdown = this.sabotage.kind === "meltdown";
      this.sabotage = null;
      if (wasMeltdown) {
        this.endMatch("imposter", "The reactor went critical.");
        return;
      }
      this.system("The grid stabilised on its own.");
      this.events.push({ kind: "repair", t: this.time, sabotage: "blackout" });
    }
  }

  // -- AI decisions --------------------------------------------------------

  /**
   * How alone a target looks to `observer`: distance from the target to the
   * nearest other actor the observer can *also see*. Actors outside the
   * observer's sight do not count, so isolation is judged only from what is in
   * front of the agent — 9999 when nobody else is in view.
   */
  private isolationInView(target: Actor, observer: Actor): number {
    let best = Infinity;
    for (const other of this.actors) {
      if (other === target || other === observer || !other.alive) continue;
      if (!this.visible(observer, other.entity.x, other.entity.y)) continue;
      const d = Math.hypot(other.entity.x - target.entity.x, other.entity.y - target.entity.y);
      if (d < best) best = d;
    }
    return Number.isFinite(best) ? Math.round(best) : 9999;
  }

  /**
   * The bar must stay *reachable*. Task credit is a per-agent quota, so the
   * moment someone dies the remaining total would be impossible and the crew
   * could never win on tasks again. Recomputing the target from whoever is
   * still alive keeps the endgame honest.
   */
  private syncTaskBudget(): void {
    let remaining = 0;
    for (const a of this.actors) {
      if (a.role !== "crew" || !a.alive) continue;
      const cap = a.isPlayer ? PLAYER_TASKS : TASKS_PER_CREW;
      const done = a.isPlayer
        ? this.playerTasks.filter((t) => t.done).length
        : a.counted;
      remaining += Math.max(0, cap - done);
    }
    this.taskTotal = Math.max(this.taskComplete, this.taskComplete + remaining);
  }

  /** True when `a` is physically close enough to touch something at (x, y). */
  private inInteractRange(a: Actor, x: number, y: number): boolean {
    return a.alive && Math.hypot(x - a.entity.x, y - a.entity.y) <= INTERACT_RANGE;
  }

  /**
   * Serialize what the agent can touch from its current node (PLAN.md step 1):
   * its own consoles, live repair points, nearby bodies, the emergency beacon
   * and — for a traitor — any crewmate it could strike. Advertised ids are
   * re-resolved and re-checked by `executeInteraction`, so a hallucinated id or
   * a stale entry is refused rather than trusted.
   */
  private buildInteractables(a: Actor, zone: Zone): Interactable[] {
    const out: Interactable[] = [];
    const sees = (x: number, y: number): boolean =>
      a.alive &&
      Math.hypot(x - a.entity.x, y - a.entity.y) <= INTERACT_RANGE &&
      this.los(a.entity.x, a.entity.y, x, y);
    const here = (x: number, y: number): boolean =>
      zoneAtPoint(this.zones, this.map, x, y).id === zone.id;

    if (a.role === "crew") {
      for (const t of a.tasks) {
        if (t.done) continue;
        const poi = this.map.pointsOfInterest.find((p) => p.id === t.poiId);
        if (!poi || (!here(poi.x, poi.y) && !sees(poi.x, poi.y))) continue;
        out.push({
          id: poi.id,
          type: "TASK",
          name: t.label,
          status: "incomplete",
          in_range: sees(poi.x, poi.y),
        });
      }
    } else if (a.role === "imposter") {
      const killable = a.killCooldown <= 0 ? this.killTargetFor(a) : null;
      for (const o of this.actors) {
        if (o === a || !o.alive || o.role !== "crew") continue;
        if (!here(o.entity.x, o.entity.y) && !sees(o.entity.x, o.entity.y)) continue;
        out.push({
          id: o.key,
          type: "KILL",
          name: o.name,
          status: "alive",
          in_range: killable?.key === o.key,
        });
      }
    }

    // Repair points are open to anyone alive — a traitor may stabilise the
    // reactor to keep up the act, exactly as in Among Us. `held by another`
    // means someone else is already on that pad, which is what tells an agent
    // to take the other scanner instead of doubling up.
    if (this.sabotage) {
      const holders = this.sabotageHolders(a);
      for (const id of this.sabotage.fixPoiIds) {
        const poi = this.map.pointsOfInterest.find((p) => p.id === id);
        if (!poi || (!here(poi.x, poi.y) && !sees(poi.x, poi.y))) continue;
        out.push({
          id: poi.id,
          type: "FIX",
          name: poi.label,
          status: (holders.get(id)?.length ?? 0) > 0 ? "held by another" : "open",
          in_range: sees(poi.x, poi.y),
        });
      }
    }

    // Reporting is available to anyone who can see a corpse.
    for (const b of this.bodies) {
      if (!here(b.x, b.y) && !sees(b.x, b.y)) continue;
      out.push({
        id: String(b.id),
        type: "REPORT",
        name: `${b.name}'s body`,
        status: "unreported",
        in_range: sees(b.x, b.y),
      });
    }

    const beacon = this.map.pointsOfInterest.find((p) => p.kind === "emergency");
    if (beacon && (here(beacon.x, beacon.y) || sees(beacon.x, beacon.y))) {
      // A critical sabotage locks the emergency button; a body report is the
      // only way out, which is the Skeld's actual rule.
      const critical = this.sabotage?.kind === "meltdown";
      out.push({
        id: beacon.id,
        type: "EMERGENCY",
        name: "Emergency beacon",
        status: critical
          ? "locked — reactor critical"
          : this.emergencyCooldown > 0
            ? `recharging ${Math.ceil(this.emergencyCooldown)}s`
            : "ready",
        in_range: sees(beacon.x, beacon.y) && this.emergencyCooldown <= 0 && !critical,
      });
    }

    return out;
  }  private buildView(a: Actor): WorldView {
    const selfRoom = roomAt(this.map, a.entity.x, a.entity.y);
    const zone = zoneAtPoint(this.zones, this.map, a.entity.x, a.entity.y);
    // The feedback is consumed exactly once, so it reaches the agent's next
    // prompt (PLAN.md step 4) and is never repeated after that.
    const feedback = a.actionFeedback;
    a.actionFeedback = null;
    const neighborIds = new Set(zoneNeighbors(this.zones, zone.id).map((z) => z.id));
    const ref = (z: Zone) => ({
      id: z.id,
      name: z.name,
      kind: z.kind,
      adjacent: neighborIds.has(z.id),
    });

    const consoles = this.map.pointsOfInterest
      .filter((p) => p.kind === "task")
      .map((p) => ({
        poiId: p.id,
        label: p.label,
        roomId: p.roomId,
        roomName: roomAt(this.map, p.x, p.y).name,
      }));

    // Eyes only: an agent perceives another actor only while it currently has
    // line of sight to them. Live positions of unseen players — even who is
    // alive at all — never enter the snapshot; the past comes from the agent's
    // own memory, never from a god's-eye list.
    const others = this.actors
      .filter((o) => o !== a && o.alive && this.visible(a, o.entity.x, o.entity.y))
      .map((o) => {
        const room = roomAt(this.map, o.entity.x, o.entity.y);
        const ozone = zoneAtPoint(this.zones, this.map, o.entity.x, o.entity.y);
        return {
          key: o.key,
          name: o.name,
          roomId: room.id,
          roomName: room.name,
          zoneId: ozone.id,
          zoneName: ozone.name,
          /** How alone they look: nobody else in sight near them → 9999. */
          isolation: this.isolationInView(o, a),
          /** A fellow traitor is never a target or a suspect. */
          allied: a.mind.allies.includes(o.key),
        };
      });

    // Imposters always know their own team — table knowledge, not sight.
    const known_allies =
      a.role === "imposter" ? a.mind.allies.map((k) => this.names[k] ?? k) : [];

    // The agent's own sighting memory: where it last saw each player, from
    // moments it could actually see them. Deliberately stale — this is
    // remembered perception, never a live position.
    const last_seen = Object.entries(a.mind.lastSeen)
      .filter(([key]) => key !== a.key)
      .map(([key, seen]) => {
        const z = zoneAtPoint(this.zones, this.map, seen.x, seen.y);
        return {
          key,
          name: this.names[key] ?? key,
          zoneId: z.id,
          zoneName: z.name,
          ago: Math.max(0, Math.round(this.time - seen.t)),
        };
      })
      .sort((s1, s2) => s1.ago - s2.ago);

    // The whole match log, not a tail: every event this agent has observed,
    // timestamped, so it can reason from the opening seconds onward.
    const history = a.mind.memories.map(
      (m) => `[${formatClock(m.t)} ${m.kind}] ${m.text}`,
    );
    const decisionHistory = a.mind.journal.map((d) => ({
      at: formatClock(d.t),
      goal: d.goal,
      action: d.action,
      reasoning: d.reasoning,
    }));

    // The agent's strongest current lead, if any: the name only, never a
    // score. It drives the offline heuristic's emergency-beacon choice and is
    // deliberately left out of the model prompt (`summarise` never sees it).
    const lead = topSuspect(a.mind);

    return {
      self: {
        key: a.key,
        name: a.name,
        role: a.role,
        roomId: selfRoom.id,
        roomName: selfRoom.name,
        alive: a.alive,
        zoneId: zone.id,
        zoneName: zone.name,
      },
      // --- serialized node-graph snapshot (PLAN.md step 2) ---
      current_location: zone.name,
      current_time: formatClock(this.time),
      // `others` is already sight-only, so these are the names of everyone in view.
      visible_players: others.map((o) => o.name),
      valid_moves: zoneNeighbors(this.zones, zone.id).map(ref),
      zones: this.zones.order.map((id) => ref(this.zones.zones[id])),
      tasks: a.tasks.map((t) => ({
        poiId: t.poiId,
        label: t.label,
        roomId: t.roomId,
        roomName: t.roomName,
        done: t.done,
      })),
      consoles,
      interactables: this.buildInteractables(a, zone),
      system_message: feedback,
      others,
      known_allies,
      last_seen,
      history,
      decision_history: decisionHistory,
      // Persistent self-context, so the agent reasons between iterations
      // instead of waking up amnesiac every decision tick.
      your_goal: a.mind.goal,
      goal_since: a.mind.goal ? formatClock(a.mind.goalSince) : null,
      last_reasoning: a.mind.lastReasoning,
      last_action: a.mind.lastAction,
      last_move: a.mind.lastMove,
      meeting_history: a.mind.meetings.map((mm) => ({
        at: formatClock(mm.t),
        reason: mm.reason,
        lines: mm.lines,
        ejected: mm.ejected ? `${mm.ejected.name} (${mm.ejected.role})` : null,
      })),
      lead: lead ? (this.names[lead.key] ?? lead.key) : null,
      cooldowns: { kill: a.killCooldown },
      // Sight, not omniscience: only a body this agent can currently see counts.
      bodyOutstanding: this.bodies.some((b) => this.visible(a, b.x, b.y)),
      taskProgress: taskBarFraction({ total: this.taskTotal, complete: this.taskComplete }),
      // Cross-match context: the shift count and the names this agent walked in
      // already watching. A hunch it brought, never evidence from this round.
      shifts_played: this.legacy?.shifts ?? 0,
      your_grudges: this.grudgesByKey.get(a.key) ?? [],
      // The traitor's deception persona; null for crew and for the human.
      your_personality: a.deceptionStyle
        ? { label: personaFor(a.deceptionStyle).label, playbook: personaFor(a.deceptionStyle).playbook }
        : null,
    };
  }

  /**
   * Whether the agent can act on something *here* right now (PLAN.md step 1).
   * When true the decision loop is nudged forward so an in-range interaction is
   * offered promptly instead of waiting out the normal thinking interval.
   */
  private hasUrgentInteraction(a: Actor): boolean {
    if (this.phase !== "playing" || !a.alive) return false;

    if (a.kind === "crew") {
      // Only an agent that has stopped somewhere offers an interaction; one
      // mid-walk is still navigating and must not be interrupted.
      if ((a.entity as Crewmate).state !== "idle") return false;
      if (this.sabotage) {
        for (const id of this.sabotage.fixPoiIds) {
          const poi = this.map.pointsOfInterest.find((p) => p.id === id);
          if (
            poi &&
            this.inInteractRange(a, poi.x, poi.y) &&
            this.los(a.entity.x, a.entity.y, poi.x, poi.y)
          ) {
            return true;
          }
        }
      }
      for (const t of a.tasks) {
        if (t.done) continue;
        const poi = this.map.pointsOfInterest.find((p) => p.id === t.poiId);
        if (
          poi &&
          this.inInteractRange(a, poi.x, poi.y) &&
          this.los(a.entity.x, a.entity.y, poi.x, poi.y)
        ) {
          return true;
        }
      }
      if (a.bodyToReport !== null) {
        const body = this.bodies.find((b) => b.id === a.bodyToReport);
        if (body && this.inInteractRange(a, body.x, body.y)) return true;
      }
      // Standing at a ready beacon with a real lead is worth deciding about
      // promptly: that is when the agent calls its emergency meeting.
      const beacon = this.map.pointsOfInterest.find((p) => p.kind === "emergency");
      if (
        beacon &&
        this.sabotage?.kind !== "meltdown" &&
        this.emergencyCooldown <= 0 &&
        topSuspect(a.mind) !== null &&
        this.inInteractRange(a, beacon.x, beacon.y) &&
        this.los(a.entity.x, a.entity.y, beacon.x, beacon.y)
      ) {
        return true;
      }
      return false;
    }

    if (a.role === "imposter" && a.killCooldown <= 0) {
      return this.killTargetFor(a) !== null;
    }
    return false;
  }

  private decide(a: Actor): void {
    if (a.isPlayer || !a.alive || this.phase !== "playing") return;
    if (a.pendingDecision) return;

    // Chasing a body takes priority over any new plan — without this the
    // decision loop re-routes the witness mid-sprint and the corpse is never
    // reported. Once the witness is close enough to touch it, fall through so
    // the decision layer can emit the REPORT interaction.
    if (a.bodyToReport !== null) {
      const body = this.bodies.find((b) => b.id === a.bodyToReport);
      const canReport =
        body !== undefined &&
        this.inInteractRange(a, body.x, body.y) &&
        this.los(a.entity.x, a.entity.y, body.x, body.y);
      if (!canReport) {
        a.nextDecisionAt = this.time + 2;
        return;
      }
    }

    // Don't interrupt an agent that is mid-task: re-deciding while a crewmate
    // is working a console would restart the same task every cycle and the
    // task bar would never move. Everything else — including an agent that is
    // still walking somewhere — is free to change its mind. A live sabotage is
    // the one thing worth interrupting active work for.
    if (a.kind === "crew" && !this.sabotage) {
      if ((a.entity as Crewmate).state === "working") {
        a.nextDecisionAt = this.time + 2.5;
        return;
      }
    }

    const view = this.buildView(a);
    // Any raw reply stashed from a previous attempt must not bleed into this
    // decision's feed row: only a reply that arrives for *this* attempt (via
    // `contextFor(a).onRaw`) may be attached to it.
    this.lastRawByKey.delete(a.key);
    // A live hazard collapses everyone's decision lull: with the Skeld's long
    // cross-map runs, a 10-16s cadence means the crew arrives at the repair
    // panel with no time left to actually choose FIX.
    //
    // A traitor whose kill is off cooldown thinks just as fast: with the
    // sight-only view it has to close distance on prey it can see, and a 7-11s
    // cadence burns the whole ready window between decisions.
    const imposterReady = a.role === "imposter" && a.killCooldown <= 0;
    const nextIn =
      this.sabotage && a.kind === "crew"
        ? this.rng.range(1.5, 3)
        : a.role === "imposter"
          ? imposterReady
            ? this.rng.range(2, 4)
            : this.rng.range(7, 11)
          : this.rng.range(10, 16);
    a.nextDecisionAt = this.time + nextIn;
    if (this.llmEnabled && a.cfg) {
      const seq = ++a.decisionSeq;
      a.pendingDecision = true;
      void intentWithModel(this.contextFor(a), view)
        .then((intent) => {
          a.pendingDecision = false;
          if (intent) {
            this.llmCalls++;
            if (this.phase === "playing" && a.alive && seq === a.decisionSeq) {
              this.applyIntent(a, intent, "model");
            }
          } else {
            this.llmFallbacks++;
            if (this.phase === "playing" && a.alive) {
              this.applyIntent(a, heuristicIntent(view, () => this.rng.next()), "heuristic");
            }
          }
        })
        .catch(() => {
          a.pendingDecision = false;
          this.llmFallbacks++;
        });
      return;
    }

    this.applyIntent(a, heuristicIntent(view, () => this.rng.next()), "heuristic");
  }

  /**
   * Resolve a `MOVE` target exactly as the agent expressed it: a point of
   * interest id ("task_medbay", the emergency beacon), a body id, an actor
   * (key or name), or a zone. The engine walks the agent to what it named —
   * it never substitutes its own destination for the one the agent chose.
   */
  private resolveMoveTarget(
    raw: string,
  ):
    | { kind: "poi"; poi: PointOfInterest }
    | { kind: "body"; body: Body }
    | { kind: "actor"; actor: Actor }
    | { kind: "zone"; zone: Zone }
    | null {
    const wanted = raw.trim().toLowerCase();
    if (!wanted) return null;

    const poi = this.map.pointsOfInterest.find((p) => p.id.toLowerCase() === wanted);
    if (poi) return { kind: "poi", poi };

    const body = this.bodies.find((b) => String(b.id) === wanted);
    if (body) return { kind: "body", body };

    const actor = this.actors.find(
      (o) => o.alive && (o.key.toLowerCase() === wanted || o.name.toLowerCase() === wanted),
    );
    if (actor) return { kind: "actor", actor };

    const zone = zoneByRef(this.zones, raw);
    if (zone) return { kind: "zone", zone };

    return null;
  }

  /**
   * Translate the model's decision into physical movement or a validated
   * interaction. `MOVE` is executed exactly as the agent expressed it — the
   * engine resolves the named destination and lets A* walk the sprite there,
   * without substituting its own goal; `INTERACT` is refused or executed by
   * the engine referee. There is no `VENT` or `SABOTAGE` branch: those
   * abilities were removed from the AI vocabulary and nothing can trigger them.
   */
  private applyIntent(a: Actor, intent: Intent, source: ThoughtSource = "heuristic"): void {
    if (intent.action === "INTERACT") {
      const verb =
        intent.interaction_type === "TASK"
          ? "Work a console"
          : intent.interaction_type === "KILL"
            ? "Kill a target"
            : intent.interaction_type === "FIX"
              ? "Fix the sabotage"
              : intent.interaction_type === "REPORT"
                ? "Report a body"
                : "Call an emergency meeting";
      const here = this.zones.zones[a.zoneId]?.name ?? a.zoneId;
      this.recordDecision(a, `${verb} in ${here}`, `${verb} (${intent.target})`, intent.reasoning, source);
      const failure = this.executeInteraction(a, intent);
      // A failed action never happens; instead the reason is attached to the
      // agent and delivered as `system_message` on its next decision.
      if (failure) a.actionFeedback = `Action Failed: ${failure}`;
      return;
    }

    // --- MOVE: executed exactly as the agent expressed it -----------------
    const dest = this.resolveMoveTarget(intent.target);
    if (!dest) {
      // The agent named something that does not exist; explain on its next turn.
      a.actionFeedback = `Action Failed: there is nothing called '${intent.target}' to walk to. Name a zone, a player, or an object (console, beacon, body).`;
      return;
    }
    const label =
      dest.kind === "poi"
        ? dest.poi.label
        : dest.kind === "body"
          ? `${dest.body.name}'s body`
          : dest.kind === "actor"
            ? dest.actor.name
            : dest.zone.name;
    a.mind.lastMove = label;
    this.recordDecision(a, `Move to ${label}`, `Moving to ${label}`, intent.reasoning, source);

    if (a.kind === "crew") {
      const c = a.entity as Crewmate;
      if (dest.kind === "poi") crewmateGotoPoi(c, this.map, this.grid, dest.poi.id);
      else if (dest.kind === "body") crewmateGotoPoint(c, this.grid, dest.body.x, dest.body.y);
      else if (dest.kind === "actor")
        crewmateGotoPoint(c, this.grid, dest.actor.entity.x, dest.actor.entity.y);
      else {
        const pt = standPoint(this.map, dest.zone);
        crewmateGotoPoint(c, this.grid, pt.x, pt.y);
      }
      return;
    }

    if (a.kind !== "imposter") return;
    const imp = a.entity as Imposter;
    if (dest.kind === "poi") imposterGotoPoint(imp, this.grid, dest.poi.x, dest.poi.y);
    else if (dest.kind === "body") imposterGotoPoint(imp, this.grid, dest.body.x, dest.body.y);
    else if (dest.kind === "actor") {
      // Walking to a named player is a one-shot approach to where they stand
      // right now — the imposter never locks on or keeps pursuing them.
      imposterGotoPoint(imp, this.grid, dest.actor.entity.x, dest.actor.entity.y);
    } else {
      const pt = standPoint(this.map, dest.zone);
      imposterGotoPoint(imp, this.grid, pt.x, pt.y);
    }
  }

  /**
   * Persist what the agent just decided and why, so its next prompt shows the
   * same context back to it: the goal it is committed to, the action it took
   * and the reasoning behind it.
   */
  private recordDecision(
    a: Actor,
    goal: string,
    action: string,
    reasoning?: string,
    source: ThoughtSource = "heuristic",
    json?: string | null,
  ): void {
    setGoal(a.mind, goal, this.time, reasoning ?? null, action);
    // Feed the spectator thought log. Every intent passes through here, so
    // heuristic fallbacks and model decisions both show up. When the intent
    // came from a live model the raw JSON reply is attached to the row.
    this.thoughts.push({
      id: this.nextThoughtId++,
      t: this.time,
      key: a.key,
      name: a.name,
      color: a.color,
      action,
      reasoning: reasoning ?? null,
      source,
      // Only a model-sourced decision shows a JSON blob; a heuristic fallback
      // that fired after an invalid model reply must not borrow its output.
      json: source === "model" ? (json ?? this.lastRawByKey.get(a.key) ?? null) : null,
    });
    if (this.thoughts.length > THOUGHT_FEED_MAX) this.thoughts.shift();

    // The same decision, restated on the audience channel. An agent with no
    // reasoning of its own still gets a candid line, so the confessional is
    // never empty just because the match is running on heuristics alone.
    this.confess(
      a,
      action,
      reasoning?.trim() || confessionalFallback(a.mind, this.names, a.deceptionStyle),
      source,
    );
  }

  /**
   * Record what an agent was *really* thinking.
   *
   * Nothing written here is ever serialized into another agent's prompt, so the
   * confessional can be candid while the meeting a few feet away stays a lie.
   * That asymmetry is the point: the crew hears the public line, the audience
   * hears the actual one just underneath it.
   */
  private confess(a: Actor, action: string, thought: string, source: ThoughtSource): void {
    this.confessional.push({
      id: this.nextConfessionalId++,
      t: this.time,
      key: a.key,
      name: a.name,
      color: a.color,
      role: a.role,
      action,
      thought,
      source,
      // A traitor is covering whenever it opens its mouth; that is not inferred
      // from the text, it is what the role means.
      concealing: a.role === "imposter",
    });
    // The confessional is capped, but the traitors' cover stories are the
    // reason it exists: evict the oldest *candid* entry first so a liar nobody
    // can hear any more (because the crew caught and ejected it) still leaves
    // its thoughts on the record. Once that would drain the crew channel to
    // `CONFESSIONAL_CANDID_FLOOR`, covers start going instead — both channels
    // have to stay on screen for the panel to mean anything.
    if (this.confessional.length > CONFESSIONAL_MAX) {
      const candidCount = this.confessional.reduce((n, c) => n + (c.concealing ? 0 : 1), 0);
      const evict =
        candidCount > CONFESSIONAL_CANDID_FLOOR
          ? this.confessional.findIndex((c) => !c.concealing)
          : this.confessional.findIndex((c) => c.concealing);
      this.confessional.splice(evict >= 0 ? evict : 0, 1);
    }
  }

  /**
   * Produce one public station-log entry for a generative console.
   *
   * The log is the deck's shared text: an AI writes the readout, the intercept
   * summary or the cargo note, and *every* agent can read it back in a meeting.
   * An impostor writes one too — a cover story — which is the whole reason the
   * log is interesting rather than decorative.
   *
   * Cost control, in order of importance:
   *   - one entry per console per match, so a patrol loop can never spam it;
   *   - at most `LOG_MODEL_CALLS_MAX` live model calls, after which the console's
   *     deterministic template fills in;
   *   - the template path is synchronous and hash-seeded, never touching the
   *     engine RNG, so headless replays stay byte-identical.
   */
  private writeLogEntry(a: Actor, poi: PointOfInterest, faked: boolean): void {
    if (!a.alive || this.stationLog.length >= LOG_ENTRY_MAX) return;
    if (this.loggedConsoles.has(poi.id)) return;
    const brief = logBriefFor(poi.id);
    if (!brief) return;
    // Claim the console up front: two agents can finish in the same tick, and
    // the second must not queue a duplicate entry behind the first's await.
    this.loggedConsoles.add(poi.id);

    const t = this.time;
    const room = roomAt(this.map, poi.x, poi.y).name;
    const useModel =
      this.llmEnabled &&
      a.cfg !== null &&
      this.ai.budget.remaining > 0 &&
      this.logModelCalls < LOG_MODEL_CALLS_MAX;

    const publish = (text: string, source: StationLogEntry["source"]): void => {
      const entry: StationLogEntry = {
        id: this.nextLogId++,
        t,
        key: a.key,
        name: a.name,
        color: a.color,
        poiId: poi.id,
        label: poi.label,
        room,
        text,
        source,
        faked,
      };
      this.stationLog.push(entry);
      if (this.stationLog.length > LOG_ENTRY_MAX) this.stationLog.shift();

      // The log is public by construction: everyone alive banks the same line,
      // as neutral context (weight 0), so it can be quoted in a meeting without
      // ever counting as evidence against the author.
      const line = `Station log: ${a.name} filed "${text}" at ${poi.label} in ${room}${
        faked ? " (claimed)" : ""
      }.`;
      for (const other of this.actors) {
        if (!other.alive) continue;
        remember(other.mind, { t, kind: "log", actorKey: a.key, roomId: poi.roomId, text: line });
      }
    };

    if (!useModel) {
      publish(templateLogEntry(brief, a.name, `${poi.id}:${this.stationLog.length}`), "template");
      return;
    }

    this.logModelCalls++;
    void logEntryWithModel(this.contextFor(a), {
      authorName: a.name,
      brief,
      label: poi.label,
      room,
      faked,
      traitor: a.role === "imposter",
    })
      .then((text) => {
        if (text) {
          this.llmCalls++;
          publish(text, "model");
        } else {
          this.llmFallbacks++;
          publish(templateLogEntry(brief, a.name, `${poi.id}:${this.stationLog.length}`), "template");
        }
      })
      .catch(() => {
        this.llmFallbacks++;
        publish(templateLogEntry(brief, a.name, `${poi.id}:${this.stationLog.length}`), "template");
      });
  }

  // -- interaction validation ----------------------------------------------

  /** Stop an actor wherever it stands (used when it starts an interaction). */
  private haltActor(a: Actor): void {
    if (a.kind === "crew") crewmateHalt(a.entity as Crewmate);
    else if (a.kind === "imposter") imposterHalt(a.entity as Imposter);
  }

  /** Begin a validated console task. Only ever called after the checks pass. */
  private beginTask(a: Actor, task: TaskAssignment): void {
    crewmateWorkAt(a.entity as Crewmate, this.map, task.poiId);
  }

  /**
   * The referee (PLAN.md step 3). Every `INTERACT` is re-validated here against
   * the agent's *physical* position and the current game state. It returns null
   * and performs the effect when the action is legal, or a human-readable
   * failure reason that the agent receives on its next turn.
   */
  private executeInteraction(a: Actor, intent: InteractIntent): string | null {
    const target = intent.target;

    switch (intent.interaction_type) {
      case "KILL": {
        if (a.role !== "imposter") return "you are not a traitor.";
        if (a.killCooldown > 0) {
          return `your kill cooldown is still recharging (${Math.ceil(a.killCooldown)}s).`;
        }
        const victim = this.actor(target);
        if (!victim || !victim.alive) return "there is nobody there to kill.";
        if (victim.role !== "crew") return `you cannot target ${victim.name}.`;
        const d = Math.hypot(victim.entity.x - a.entity.x, victim.entity.y - a.entity.y);
        if (d > KILL_RANGE) {
          return `you are too far away from ${victim.name} (${Math.round(d)}u away).`;
        }
        if (!this.los(a.entity.x, a.entity.y, victim.entity.x, victim.entity.y)) {
          return `something is blocking your line of sight to ${victim.name}.`;
        }
        if (this.witnesses(a, victim).length > 0) {
          return `${victim.name} is not alone — someone would see you.`;
        }
        return this.kill(a, victim) ? null : "the kill did not land.";
      }

      case "TASK": {
        if (a.role !== "crew") return "you have no tasks to work.";
        const task = a.tasks.find((t) => t.poiId === target && !t.done);
        if (!task) return `'${target}' is not one of your unfinished tasks.`;
        const poi = this.map.pointsOfInterest.find((p) => p.id === target);
        if (!poi) return `there is nothing called '${target}' here.`;
        if (!this.inInteractRange(a, poi.x, poi.y)) return `you are too far away from '${task.label}'.`;
        if (!this.los(a.entity.x, a.entity.y, poi.x, poi.y)) {
          return `something is blocking your line of sight to '${task.label}'.`;
        }
        this.beginTask(a, task);
        return null;
      }

      case "FIX": {
        // Anyone alive may work a repair pad — impostors can stabilise the
        // reactor too, which is how a traitor keeps a clean alibi.
        if (!this.sabotage) return "there is nothing to repair.";
        if (!this.sabotage.fixPoiIds.includes(target)) {
          return `'${target}' is not a live repair point.`;
        }
        const poi = this.map.pointsOfInterest.find((p) => p.id === target);
        if (!poi) return `there is nothing called '${target}' here.`;
        if (!this.inInteractRange(a, poi.x, poi.y)) {
          return "you are too far away from the repair console.";
        }
        if (!this.los(a.entity.x, a.entity.y, poi.x, poi.y)) {
          return "something is blocking your line of sight to the repair console.";
        }
        // The agent has to actually *stay* on the pad: a plain halt drops it
        // into the idle loop, which walks it off to a new task within a tick,
        // and a two-hand meltdown needs the scanner occupied, not just visited.
        a.fixUntil = this.time + REPAIR_TIME + 2;
        if (a.kind === "crew") crewmateHold(a.entity as Crewmate, REPAIR_TIME + 2);
        else this.haltActor(a);
        return null;
      }

      case "REPORT": {
        const body = this.bodies.find((b) => String(b.id) === target);
        if (!body) return "there is no body to report.";
        if (!this.inInteractRange(a, body.x, body.y)) {
          return `you are too far away from ${body.name}'s body.`;
        }
        if (!this.los(a.entity.x, a.entity.y, body.x, body.y)) {
          return `something is blocking your line of sight to ${body.name}'s body.`;
        }
        this.startMeeting({ kind: "report", byKey: a.key });
        return null;
      }

      case "EMERGENCY": {
        if (this.sabotage?.kind === "meltdown") {
          return "the reactor is critical — the beacon is locked until the meltdown is stopped or a body is reported.";
        }
        if (this.emergencyCooldown > 0) {
          return `the emergency beacon is still recharging (${Math.ceil(this.emergencyCooldown)}s).`;
        }
        const beacon = this.map.pointsOfInterest.find((p) => p.kind === "emergency");
        if (!beacon) return "there is no emergency beacon here.";
        if (!this.inInteractRange(a, beacon.x, beacon.y)) {
          return "you are too far away from the emergency beacon.";
        }
        if (!this.los(a.entity.x, a.entity.y, beacon.x, beacon.y)) {
          return "something is blocking your line of sight to the emergency beacon.";
        }
        this.startMeeting({ kind: "emergency", byKey: a.key });
        return null;
      }

      default:
        return `'${intent.interaction_type}' is not something you can do.`;
    }
  }

  // -- ghost channel -------------------------------------------------------

  /**
   * The dead talk to each other. One ghost holds the channel at a time: a
   * speaker is chosen, publishes a single candid line, and the channel stays
   * locked until that ghost's turn ends, then hushes before the next voice.
   *
   * Nothing here touches a living agent's `Mind` — the ghost channel is purely
   * additive, so it can never change who the living suspect or how they vote.
   */
  private tickGhostChat(): void {
    if (this.ghostSpeaker !== null && this.time >= this.ghostSpeakerUntil) {
      this.ghostSpeaker = null;
    }
    // One voice at a time: while a ghost holds the channel, nobody else speaks.
    if (this.ghostSpeaker !== null) return;
    if (this.time < this.ghostTurnAt) return;

    const dead = this.actors.filter((a) => !a.isPlayer && a.status === "dead");
    if (dead.length === 0) return;

    const speaker = dead[this.ghostTurn % dead.length];
    this.ghostTurn++;
    const line = ghostStatement(
      this.map,
      speaker.mind,
      { key: speaker.key, name: speaker.name },
      this.names,
      this.ghostTurn,
    );
    if (!line) return;
    this.ghostSay(speaker, line);
    this.ghostSpoken++;
    this.ghostSpeaker = speaker.key;
    this.ghostSpeakerUntil = this.time + GHOST_TALK_TIME;
    this.ghostTurnAt = this.ghostSpeakerUntil + GHOST_QUIET_TIME;
  }

  // -- reporting -----------------------------------------------------------

  private startMeeting(reason: { kind: "emergency" | "report"; byKey: string }): void {
    if (this.phase !== "playing") return;
    const by = this.actor(reason.byKey);
    if (!by) return;

    this.phase = "meeting";
    this.meetingsHeld++;
    // A reported body is the one thing that can end a critical sabotage: it
    // cancels the meltdown and starts the meeting, exactly as on The Skeld.
    // (The emergency button, by contrast, stays locked during a meltdown.)
    if (reason.kind === "report" && this.sabotage?.kind === "meltdown") {
      this.sabotage = null;
      this.system("The report interrupted the meltdown — the reactor is stable for now.");
    }
    const spawn = this.map.pointsOfInterest.find((p) => p.kind === "spawn");
    const sx = spawn?.x ?? 840;
    const sy = spawn?.y ?? 340;

    const seated = this.living();
    seated.forEach((a, i) => {
      const p = this.seatAt(sx, sy, i, seated.length, a.entity.radius);
      a.entity.x = p.x;
      a.entity.y = p.y;
      a.bodyToReport = null;
      if (a.kind === "crew") crewmateHalt(a.entity as Crewmate);
      if (a.kind === "imposter") imposterHalt(a.entity as Imposter);
    });
    revealAround(this.vis, sx, sy, 320);

    const living = this.living();
    const meeting: Meeting = {
      startedAt: this.time,
      stage: "discussion",
      timer: DISCUSSION_TIME,
      reason,
      votes: {},
      ejected: null,
      ejectedRole: null,
      playerLine: null,
      spoken: new Map(),
      turnAt: this.time + 1.5,
      lastSpeaker: null,
      msgStart: this.messages.length,
      claimsApplied: new Set(),
      speaker: null,
      speakerSeq: 0,
    };

    for (const a of living) a.voteAt = 0;

    this.meeting = meeting;
    // Everyone respawns metres from the beacon — without a lockout the very
    // next keypress would call another meeting.
    this.emergencyCooldown = 45;
    this.system(
      reason.kind === "emergency"
        ? `${by.name} called an emergency meeting.`
        : `${by.name} reported a body.`,
    );
    this.events.push({
      kind: "meeting",
      t: this.time,
      reason: reason.kind,
      byKey: by.key,
      byName: by.name,
    });
  }

  report(byKey?: string): boolean {
    if (this.phase !== "playing") return false;
    const me = this.actor(byKey ?? "player");
    if (!me || !me.alive) return false;

    for (const b of this.bodies) {
      if (Math.hypot(b.x - me.entity.x, b.y - me.entity.y) <= INTERACT_RANGE) {
        this.startMeeting({ kind: "report", byKey: me.key });
        return true;
      }
    }
    return false;
  }

  private aiReportChecks(): void {
    if (this.phase !== "playing") return;
    for (const a of this.actors) {
      if (a.isPlayer || !a.alive || a.bodyToReport === null) continue;
      const body = this.bodies.find((b) => b.id === a.bodyToReport);
      if (!body) {
        a.bodyToReport = null;
        continue;
      }
      const d = Math.hypot(body.x - a.entity.x, body.y - a.entity.y);
      if (d <= INTERACT_RANGE) {
        // Close enough: stop and let the decision layer emit the REPORT
        // interaction, which the engine then validates like any other.
        this.haltActor(a);
        a.repathAt = this.time + 0.5;
        continue;
      }
      if (this.time >= a.repathAt) {
        crewmateGotoPoint(a.entity as Crewmate, this.grid, body.x, body.y, true);
        a.repathAt = this.time + 1.6;
      }
    }
  }

  // -- meetings ------------------------------------------------------------

  private tickMeeting(dt: number): void {
    const m = this.meeting;
    if (!m) {
      this.phase = "playing";
      return;
    }

    m.timer -= dt;
    const living = this.living();

    if (m.stage === "discussion") {
      // A model reply that never lands must not freeze the room: free the token
      // after the deadline so the discussion keeps flowing.
      if (m.speaker && this.time - m.speaker.since > SPEAKER_DEADLINE) {
        m.speaker = null;
        m.turnAt = this.time + 0.5;
      }
      // Only start a turn when nobody holds the token — one voice at a time.
      if (!m.speaker && this.time >= m.turnAt) this.discussionTurn(m, living);
      if (m.timer <= 0) this.openVoting(m, living);
      return;
    }

    if (m.stage === "voting") {
      for (const a of living) {
        if (a.isPlayer || m.votes[a.key] !== undefined) continue;
        if (this.time >= a.voteAt) {
          m.votes[a.key] = this.chooseVote(a, living);
        }
      }
      const allVoted = living.every((a) => m.votes[a.key] !== undefined);
      if (allVoted || m.timer <= 0) {
        for (const a of living) if (m.votes[a.key] === undefined) m.votes[a.key] = null;
        this.resolveVote(m, living);
        m.stage = "tally";
        m.timer = TALLY_TIME;
      }
      return;
    }

    if (m.timer <= 0) this.finishMeeting();
  }

  private openVoting(m: Meeting, living: Actor[]): void {
    if (m.stage !== "discussion") return;
    m.stage = "voting";
    m.timer = VOTING_TIME;
    // Any outstanding speaker token dies with the discussion.
    m.speaker = null;
    let i = 0;
    for (const a of living) {
      if (a.isPlayer) continue;
      if (m.votes[a.key] !== undefined) continue;
      a.voteAt = this.time + 1.2 + i * 1.4 + this.rng.range(0, 1);
      i++;
    }
    this.system("Voting is open.");
  }

  /** The human can cut the discussion short. */
  advanceMeeting(): void {
    const m = this.meeting;
    if (!m || m.stage !== "discussion") return;
    this.openVoting(m, this.living());
  }

  /**
   * One turn of the standing discussion. The room keeps talking until the
   * timer runs out: each turn picks the agent that has spoken least (never
   * the same voice twice in a row) and schedules the next reply a couple of
   * seconds out, so the meeting reads as a real back-and-forth rather than a
   * one-shot roll call followed by silence.
   */
  private discussionTurn(m: Meeting, living: Actor[]): void {
    // One voice at a time: a new turn is never granted while one is live.
    if (m.speaker) {
      this.meetingSpeakerOverlaps++;
      return;
    }
    const candidates = living.filter((a) => !a.isPlayer);
    if (candidates.length === 0) {
      m.turnAt = this.time + TURN_GAP_MIN + this.rng.range(0, TURN_GAP_JITTER);
      return;
    }
    const fewest = Math.min(...candidates.map((a) => m.spoken.get(a.key) ?? 0));
    let pool = candidates.filter(
      (a) => (m.spoken.get(a.key) ?? 0) === fewest && a.key !== m.lastSpeaker,
    );
    if (pool.length === 0) pool = candidates.filter((a) => a.key !== m.lastSpeaker);
    if (pool.length === 0) pool = candidates;
    const speaker = this.rng.pick(pool);
    m.spoken.set(speaker.key, (m.spoken.get(speaker.key) ?? 0) + 1);
    m.lastSpeaker = speaker.key;
    m.speakerSeq++;
    m.speaker = { key: speaker.key, name: speaker.name, seq: m.speakerSeq, since: this.time };
    this.meetingSpeakerTurns++;
    this.speak(speaker, m);
  }

  /**
   * Release the speaking token and queue the next turn. Only the holder's own
   * turn may do this (the `seq` guard), so a late reply from a superseded turn
   * can never free — or extend — someone else's turn.
   */
  private releaseSpeaker(m: Meeting, seq: number): void {
    if (m.speaker?.seq !== seq) return;
    m.speaker = null;
    m.turnAt = this.time + TURN_GAP_MIN + this.rng.range(0, TURN_GAP_JITTER);
  }

  /** Speech-only lines of the running meeting — agents' lines and the human's. */
  private meetingTranscript(m: Meeting): { speaker: string; text: string }[] {
    return this.messages
      .slice(m.msgStart)
      .filter((c) => c.kind === "statement" || c.kind === "player")
      .slice(-TRANSCRIPT_WINDOW)
      .map((c) => ({ speaker: c.speakerName, text: c.text }));
  }

  /** Everything the human has said this meeting, oldest first. */
  private meetingHumanLines(m: Meeting): string[] {
    return this.messages
      .slice(m.msgStart)
      .filter((c) => c.kind === "player")
      .slice(-8)
      .map((c) => c.text);
  }

  private speak(a: Actor, m: Meeting): void {
    // The speaking token is the gate: without it, an agent cannot talk.
    const token = m.speaker;
    if (!token || token.key !== a.key) {
      this.meetingSpeakerViolations++;
      return;
    }
    // Same freshness rule as `decide`: a statement may only show the raw JSON
    // that arrives for its own model call.
    this.lastRawByKey.delete(a.key);
    const input = {
      others: this.living().map((x) => x.key),
      playerLine: m.playerLine,
      // The running discussion (including the human's lines) as it stood
      // before this turn, so the agent can respond to what was actually said.
      transcript: this.meetingTranscript(m),
      humanLines: this.meetingHumanLines(m),
      turn: m.spoken.get(a.key) ?? 1,
      bodiesFound: this.bodies.length,
      ejectedSoFar: [] as string[],
      // A traitor's persona and the room it will claim it was working in.
      style: a.deceptionStyle,
      alibiRoomId: this.alibiRoomFor(a),
    };

    const post = (stmt: Statement, source: ThoughtSource, json?: string | null): void => {
      // Late model replies must not leak into voting, the next meeting, or a
      // turn whose token has already moved on.
      if (this.meeting !== m || m.stage !== "discussion" || m.speaker?.seq !== token.seq) {
        return;
      }
      // The spoken line belongs in the meeting chat itself — without this the
      // agents would only appear in the thought feed and confessional, and the
      // room would read as silent.
      this.say(a, stmt.line);
      // Meeting lines belong in the feed too: what the agent said and, for
      // model statements, the raw JSON reply the line was parsed out of.
      this.thoughts.push({
        id: this.nextThoughtId++,
        t: this.time,
        key: a.key,
        name: a.name,
        color: a.color,
        action: `Said: ${stmt.line.slice(0, 96)}${stmt.line.length > 96 ? "..." : ""}`,
        reasoning: null,
        source,
        json: source === "model" ? (json ?? this.lastRawByKey.get(a.key) ?? null) : null,
      });
      if (this.thoughts.length > THOUGHT_FEED_MAX) this.thoughts.shift();

      // The confessional: what it said, and what it was actually thinking while
      // it said it. A live model gives both channels in one call; a scripted
      // line gets a stand-in private thought so the panel never goes quiet.
      this.confess(
        a,
        `Said: ${stmt.line.slice(0, 140)}${stmt.line.length > 140 ? "..." : ""}`,
        stmt.thinking?.trim() || confessionalFallback(a.mind, this.names, a.deceptionStyle),
        source,
      );

      // A structured claim is public: hand it to every other listener's belief
      // model, where it either shades their read or exposes the speaker.
      this.applyClaim(a, m, stmt.claim);
      // The line has landed: hand the channel to the next voice.
      this.releaseSpeaker(m, token.seq);
    };

    if (this.llmEnabled && a.cfg) {
      void statementWithModel(this.contextFor(a), this.map, a.mind, { key: a.key, name: a.name }, this.names, input)
        .then((stmt) => {
          if (stmt) {
            this.llmCalls++;
            post(stmt, "model");
          } else {
            this.llmFallbacks++;
            post(fallbackStatement(this.map, a.mind, { key: a.key, name: a.name }, this.names, input), "heuristic");
          }
        })
        .catch(() => {
          this.llmFallbacks++;
          post(fallbackStatement(this.map, a.mind, { key: a.key, name: a.name }, this.names, input), "heuristic");
        });
      return;
    }

    post(heuristicStatement(this.map, a.mind, { key: a.key, name: a.name }, this.names, input), "heuristic");
  }

  /**
   * The room a traitor will name in its alibi: the console it last faked work
   * at, falling back to wherever it stands. Crew never offer an alibi, so this
   * is null for them and the claim cannot be manufactured on their behalf.
   */
  private alibiRoomFor(a: Actor): RoomId | null {
    if (a.kind !== "imposter") return null;
    const imp = a.entity as Imposter;
    const poi = imp.lastFakedPoiId
      ? this.map.pointsOfInterest.find((p) => p.id === imp.lastFakedPoiId)
      : undefined;
    return roomAt(this.map, poi?.x ?? a.entity.x, poi?.y ?? a.entity.y).id;
  }

  /**
   * Hand a statement's structured claim to every other living agent's belief
   * model. The engine never invents a belief: it records what the listener
   * *heard*, and the weight comes from the claim's kind — an unchallenged
   * accusation raises suspicion, a vouch lowers it, and a claim the listener's
   * own memory proves false brands the speaker a liar instead.
   *
   * One speaker may not stack the same claim on the same target all meeting,
   * so a single traitor cannot talk a target over the voting threshold alone.
   */
  private applyClaim(speaker: Actor, m: Meeting, claim: Claim | null | undefined): void {
    if (!claim) return;
    const id = `${speaker.key}|${claim.kind}|${claim.about}`;
    if (m.claimsApplied.has(id)) return;
    m.claimsApplied.add(id);

    const roomId = claim.roomId ?? roomAt(this.map, speaker.entity.x, speaker.entity.y).id;
    for (const listener of this.actors) {
      if (listener === speaker || !listener.alive) continue;
      const verdict = judgeClaim(listener.mind, speaker.key, claim, this.time);
      if (verdict.contradicted) {
        // Being falsely accused makes you *suspect* the accuser, not convict
        // them: the weaker `accuse` weight. Only a lie the listener's memory
        // can actually check — a wrong alibi, a disprovable sighting, a bad
        // vouch — is a `caught` lie, and that is what gets a traitor voted out.
        remember(listener.mind, {
          t: this.time,
          kind: verdict.reason === "self" ? "accuse" : "caught",
          actorKey: speaker.key,
          roomId,
          text: contradictionNote(this.map, speaker.name, claim, verdict, this.names),
        });
      } else if (claim.kind === "accuse" || claim.kind === "vouch") {
        remember(listener.mind, {
          t: this.time,
          kind: claim.kind === "accuse" ? "accuse" : "vouch",
          actorKey: claim.about,
          roomId,
          text: claimMemoryText(this.map, speaker.name, claim, this.names),
        });
      }
      // An alibi nobody can contradict is simply unverifiable and moves nothing.
    }
  }

  /**
   * What a listener hears, it may act on: a public claim enters its belief
   * model through the same `remember` path as its own eyes, so what an agent
   * says can always be audited against what it observed.
   */
  playerSay(text: string): void {
    if (this.spectator) return;
    const m = this.meeting;
    if (!m || m.stage !== "discussion") return;
    const trimmed = text.trim().slice(0, 200);
    if (!trimmed) return;
    const me = this.playerActor;
    m.playerLine = trimmed;
    this.say(me, trimmed, "player");
    // A human remark deserves a reply — pull the next agent turn forward.
    if (m.stage === "discussion") m.turnAt = Math.min(m.turnAt, this.time + 1.2);
  }

  private chooseVote(a: Actor, living: Actor[]): string | null {
    const candidates = living.filter((x) => x.key !== a.key && !a.mind.allies.includes(x.key));
    const top = topSuspect(a.mind, 0.22);
    if (top && candidates.some((c) => c.key === top.key)) return top.key;
    if (a.role === "imposter") {
      // Never waste the vote: pick whoever is currently loudest against you.
      const accusers = rankSuspects(a.mind, 0.1).filter((s) => candidates.some((c) => c.key === s.key));
      if (accusers.length > 0) return accusers[0].key;
      return this.rng.chance(0.35) && candidates.length > 0
        ? candidates[this.rng.int(candidates.length)].key
        : null;
    }
    // Crew without evidence mostly abstain: an unjust ejection costs far more
    // than a skipped vote, and the deck is racing the task bar.
    return this.rng.chance(0.15) && candidates.length > 0
      ? candidates[this.rng.int(candidates.length)].key
      : null;
  }

  playerVote(targetKey: string | null): void {
    if (this.spectator) return;
    const m = this.meeting;
    if (!m || m.stage !== "voting") return;
    m.votes["player"] = targetKey;
  }

  private resolveVote(m: Meeting, living: Actor[]): void {
    const tally = new Map<string, number>();
    for (const target of Object.values(m.votes)) {
      const key = target ?? "skip";
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }

    let bestKey: string | null = null;
    let bestCount = 0;
    let tie = false;
    for (const [key, count] of tally) {
      if (count > bestCount) {
        bestKey = key;
        bestCount = count;
        tie = false;
      } else if (count === bestCount) {
        tie = true;
      }
    }

    if (!bestKey || tie || bestKey === "skip" || bestCount <= 1) {
      this.system("No consensus — nobody was ejected.");
      return;
    }

    const ejected = this.actor(bestKey);
    if (!ejected || !ejected.alive) {
      this.system("No consensus — nobody was ejected.");
      return;
    }

    const ejectedRoom = roomAt(this.map, ejected.entity.x, ejected.entity.y).id;

    this.setActorStatus(ejected, "dead");

    this.ejects++;
    m.ejected = ejected.key;
    m.ejectedRole = ejected.role;
    // Bank the ejection with its voters. This is the raw material for next
    // shift's grudges: an innocent who was voted out blames every name on this
    // list, so the ledger can carry the grudge into a match it did not play in.
    // The bank stores cross-match identities (the model behind the seat),
    // while the public event timeline below keeps the display names.
    const voterNames = Object.entries(m.votes)
      .filter(([, target]) => target === ejected.key)
      .map(([key]) => this.names[key] ?? key);
    this.ejections.push({
      name: this.identityOf(ejected),
      role: ejected.role,
      voters: voterNames.map((n) => this.identityOfName(n)),
    });
    this.events.push({
      kind: "eject",
      t: this.time,
      key: ejected.key,
      name: ejected.name,
      role: ejected.role,
      voters: voterNames,
    });

    for (const a of living) {
      remember(a.mind, {
        t: this.time,
        kind: "eject",
        actorKey: ejected.key,
        roomId: ejectedRoom,
        text: `${ejected.name} was voted out (${ejected.role}).`,
      });
    }

    this.system(
      ejected.role === "imposter"
        ? `${ejected.name} was ejected — they were an imposter.`
        : `${ejected.name} was ejected — they were innocent.`,
    );
  }

  private finishMeeting(): void {
    const m = this.meeting;
    // Bank the meeting as a per-agent memory *before* the state is torn down,
    // so every agent can recall what was said and decided afterwards.
    if (m) this.recordMeetingMemory(m);
    this.meeting = null;
    this.bodies = [];
    for (const a of this.actors) {
      a.mind.bodiesSeen.clear();
      a.bodyToReport = null;
      a.mind.hasReported = false;
    }

    if (this.checkWin()) return;

    this.phase = "playing";
    if (m) {
      for (const a of this.living()) a.killCooldown = Math.max(a.killCooldown, 6);
    }
    this.system("Meeting adjourned — back to work.");
  }

  /**
   * Turn the finished meeting into a complete recap for every agent. The lines
   * are the meeting's whole transcript, and the reason/ejection are the engine's
   * own verdicts, so later reasoning is grounded in what really happened rather
   * than in whatever an agent imagined.
   */
  private recordMeetingMemory(m: Meeting): void {
    const byName = this.names[m.reason.byKey] ?? m.reason.byKey;
    const reason =
      m.reason.kind === "emergency"
        ? `${byName} called an emergency meeting`
        : `${byName} reported a body`;
    const lines = this.messages
      .slice(m.msgStart)
      .map((c) => `${c.speakerName}: ${c.text}`);
    const ejected = m.ejected
      ? {
          key: m.ejected,
          name: this.names[m.ejected] ?? m.ejected,
          role: (m.ejectedRole ?? "crew") as Role,
        }
      : null;

    for (const a of this.actors) {
      rememberMeeting(a.mind, { t: this.time, reason, lines, ejected });
    }
  }

  // -- win conditions ------------------------------------------------------

  private endMatch(winner: "crew" | "imposter", reason: string): void {
    if (this.phase === "ended") return;
    this.winner = winner;
    this.phase = "ended";
    this.system(reason);
    this.events.push({ kind: "end", t: this.time, winner, reason });
    // The debrief: every agent learns who the imposters really were.
    this.publishReveal();
    this.onMatchEnd?.(winner);
  }

  /**
   * End-of-match reveal. Once the verdict lands the simulation stops being a
   * game of hidden roles, so every AI is told the truth: the imposters are
   * announced on the public channel and written into each agent's memory log as
   * a `reveal` entry. Because it is a memory, the knowledge is auditable — an
   * agent that held a wrong read all shift ends up holding the right answer —
   * and because its kind weighs zero it can never move a belief.
   *
   * It runs exactly once, guarded by the `phase === "ended"` check in
   * `endMatch`, and never while the match is still live.
   */
  private publishReveal(): void {
    const imposters = this.actors.filter((a) => a.role === "imposter");
    this.reveal = imposters.map((a) => ({ key: a.key, name: a.name, color: a.color }));

    const names = imposters.map((a) => a.name);
    const announce =
      names.length <= 1
        ? `The imposter was ${names[0] ?? "unknown"}.`
        : `The imposters were ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}.`;
    this.system(announce);

    // Tell every AI — the dead included. The player seat is skipped: the reveal
    // is for the agents, and the gallery already sees the roster's roles.
    let informed = 0;
    for (const a of this.actors) {
      if (a.isPlayer) continue;
      for (const imp of imposters) {
        remember(a.mind, {
          t: this.time,
          kind: "reveal",
          actorKey: imp.key,
          roomId: roomAt(this.map, imp.entity.x, imp.entity.y).id,
          text: `${imp.name} was an imposter.`,
        });
      }
      informed++;
    }
    this.revealedTo = informed;
  }

  private checkWin(): boolean {
    if (this.phase === "ended") return true;
    const crew = this.living("crew").length;
    const imps = this.living("imposter").length;

    if (imps === 0) {
      this.endMatch("crew", "Every imposter has been ejected. Crew win.");
      return true;
    }
    if (imps >= crew) {
      this.endMatch("imposter", "The imposters outnumber the crew. Imposters win.");
      return true;
    }
    if (this.taskTotal > 0 && this.taskComplete >= this.taskTotal) {
      this.endMatch("crew", "All station tasks are complete. Crew win.");
      return true;
    }
    return false;
  }

  // -- player interaction --------------------------------------------------

  private nearestInteractable(): PointOfInterest | null {
    let best: PointOfInterest | null = null;
    let bestD = INTERACT_RANGE;
    for (const p of this.map.pointsOfInterest) {
      if (p.kind === "spawn") continue;
      const d = Math.hypot(p.x - this.player.x, p.y - this.player.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  prompt(): string | null {
    if (this.phase !== "playing") return null;
    const me = this.playerActor;
    if (!me.alive) {
      return this.spectator ? "SPECTATING — full station vision" : "SPECTATING — you are dead";
    }

    const nearBody = this.bodies.some(
      (b) => Math.hypot(b.x - this.player.x, b.y - this.player.y) <= INTERACT_RANGE,
    );
    const parts: string[] = [];
    if (nearBody) parts.push("R — report body");

    const poi = this.nearestInteractable();
    if (poi) {
      if (poi.kind === "emergency") {
        parts.push(
          this.sabotage?.kind === "meltdown"
            ? "E — beacon locked (reactor critical)"
            : this.emergencyCooldown > 0
              ? `E — beacon recharging ${Math.ceil(this.emergencyCooldown)}s`
              : "E — emergency meeting",
        );
      }
      if (poi.kind === "task") {
        const mine = me.tasks.find((t) => t.poiId === poi.id);
        if (mine && !mine.done) parts.push(`E — ${mine.label}`);
        else if (me.role === "imposter") parts.push(`E — fake ${poi.label}`);
      }
      if (poi.kind === "vent" && me.role === "imposter") parts.push("E — vent");
      if (
        poi.kind === "sabotage" &&
        this.sabotage &&
        this.sabotage.fixPoiIds.includes(poi.id)
      ) {
        const pct = Math.round(this.sabotage.fixProgress * 100);
        if (this.sabotage.kind === "meltdown") {
          // The second scanner is the whole mechanic: say whether a partner is
          // already holding it, the way the real panel reads "WAITING FOR
          // SECOND USER" until both hands are down.
          const holders = this.sabotageHolders();
          const secondUser = this.sabotage.fixPoiIds
            .filter((id) => id !== poi.id)
            .every((id) => (holders.get(id)?.length ?? 0) > 0);
          parts.push(
            secondUser
              ? `HOLD E — reactor stabilising (${pct}%)`
              : "HOLD E — waiting for second user",
          );
        } else {
          parts.push(`HOLD E — repair (${pct}%)`);
        }
      }
    }

    if (me.role === "imposter") {
      if (me.killCooldown <= 0 && this.killTargetFor(me)) parts.push("SPACE — kill");
      if (!this.sabotage && this.sabotageCooldown <= 0) parts.push("Q — sabotage");
    }

    return parts.length > 0 ? parts.join("   ·   ") : null;
  }

  interact(): void {
    if (this.phase !== "playing") return;
    const me = this.playerActor;
    if (!me.alive) return;
    const poi = this.nearestInteractable();
    if (!poi) return;

    if (poi.kind === "emergency") {
      if (this.sabotage?.kind === "meltdown") {
        this.note("The reactor is critical — the beacon is locked out.");
        return;
      }
      if (this.emergencyCooldown > 0) {
        this.note(`Emergency beacon recharging — ${Math.ceil(this.emergencyCooldown)}s.`);
        return;
      }
      this.startMeeting({ kind: "emergency", byKey: "player" });
      return;
    }

    if (poi.kind === "task" && me.role === "crew") {
      const task = me.tasks.find((t) => t.poiId === poi.id && !t.done);
      if (task) this.activeTask = task;
      return;
    }

    if (poi.kind === "vent" && me.role === "imposter") {
      const other = this.map.pointsOfInterest.filter(
        (p) => p.kind === "vent" && p.id !== poi.id,
      );
      const dest = other[this.rng.int(other.length)];
      this.player.x = dest.x;
      this.player.y = dest.y;
      revealAround(this.vis, dest.x, dest.y, 220);
      this.note("You slipped through the ducts.");
      return;
    }

    if (poi.kind === "task" && me.role === "imposter") {
      this.note("You pretend to work the console.");
    }
  }

  /** Called by the minigame overlay when the player finishes it. */
  completeActiveTask(): boolean {
    const task = this.activeTask;
    const me = this.playerActor;
    this.activeTask = null;
    if (!task || !me.alive || task.done || this.phase !== "playing") return false;

    task.done = true;
    this.taskComplete = Math.min(this.taskTotal, this.taskComplete + 1);
    this.syncTaskBudget();
    this.system(`Task complete: ${task.label}.`);
    remember(me.mind, {
      t: this.time,
      kind: "task",
      actorKey: "player",
      roomId: task.roomId,
      text: `Worked ${task.label}.`,
    });
    this.checkWin();
    return true;
  }

  cancelActiveTask(): void {
    this.activeTask = null;
  }

  // -- tick ----------------------------------------------------------------

  tick(dt: number): void {
    if (this.phase === "ended" || this.phase === "briefing") return;
    this.time += dt;

    if (this.phase === "meeting") {
      this.tickMeeting(dt);
      return;
    }

    // --- playing ----------------------------------------------------------
    const playerActor = this.playerActor;
    // A spectator's avatar is a ghost: it never moves and never reveals.
    if (!this.spectator) updatePlayer(this.map, this.player, this.moveInput(), dt);
    if (playerActor.alive) revealAround(this.vis, this.player.x, this.player.y, 140);

    const livingCrew = this.crewmates.filter((c) => {
      const actor = this.actors.find((a) => a.entity === c);
      return actor?.alive;
    });
    for (const c of livingCrew) updateCrewmate(this.map, this.grid, c, dt);

    const livingImps = this.imposters.filter((i) => {
      const actor = this.actors.find((a) => a.entity === i);
      return actor?.alive;
    });
    for (const i of livingImps) {
      // Venting is only safe when nobody is in sight: vision is symmetric, so
      // an imposter that cannot see the crew cannot be seen by them either.
      const imp = this.actors.find((a) => a.entity === i)!;
      const watched = this.actors.some(
        (o) => o.alive && o.role === "crew" && this.visible(imp, o.entity.x, o.entity.y),
      );
      updateImposter(this.map, this.grid, i, !watched, dt);
    }

    // Keep the zone graph in sync with where everyone physically is.
    this.refreshZones();

    for (const a of this.actors) {
      if (!a.alive) continue;
      if (a.killCooldown > 0) a.killCooldown = Math.max(0, a.killCooldown - dt);
      if (!a.isPlayer && this.time >= a.nextDecisionAt) {
        this.decide(a);
      } else if (
        !a.isPlayer &&
        !a.pendingDecision &&
        this.time >= a.urgencyAt &&
        this.hasUrgentInteraction(a)
      ) {
        // Something actionable is in reach: decide again shortly, at most once
        // every half second so a rejected action cannot spin the model.
        a.urgencyAt = this.time + 0.5;
        a.nextDecisionAt = this.time + 0.05;
      }
      // Safety net: never let a teleport leave an actor stranded in a wall.
      if (!canStand(this.map, a.entity.x, a.entity.y, a.entity.radius)) {
        const p = nearestStandable(this.map, a.entity.x, a.entity.y, a.entity.radius);
        a.entity.x = p.x;
        a.entity.y = p.y;
      }
    }

    // AI crew task credit toward the shared bar. `processed` tracks which
    // completions have been examined; `counted` is how many of them were real
    // console tasks (repairing a sabotage also ticks `completedTasks`, and
    // spending a credit on that would make the bar unreachable).
    for (const a of this.actors) {
      if (a.kind !== "crew" || !a.alive) continue;
      const c = a.entity as Crewmate;
      if (c.completedTasks <= a.processed) continue;
      a.processed = c.completedTasks;
      const poi = this.map.pointsOfInterest.find((p) => p.id === c.lastPoiId);
      // A generative console pays out content the moment the work lands —
      // before the quota decides whether it also counts toward the task bar.
      if (poi?.kind === "task") this.writeLogEntry(a, poi, false);
      if (poi?.kind !== "task") continue;
      if (a.counted >= TASKS_PER_CREW) continue;
      a.counted++;
      // Tick the console off the agent's own list as well as the shared bar.
      // Without this the assignment never clears, `hasUrgentInteraction` keeps
      // offering the same console and the crewmate re-works it forever instead
      // of walking its list — which is what an assignment is for. It also makes
      // the generative consoles reachable at all.
      const owned = a.tasks.find((t) => t.poiId === poi.id);
      if (owned) owned.done = true;
      this.taskComplete = Math.min(this.taskTotal, this.taskComplete + 1);
      if (this.taskComplete >= this.taskTotal) this.checkWin();
    }

    // Impostors bank a finished alibi the same way, and a console that no one
    // has logged yet gives them a place to file a public cover story.
    for (const a of this.actors) {
      if (a.kind !== "imposter" || !a.alive) continue;
      const imp = a.entity as Imposter;
      if (imp.fakedTasks <= a.processed) continue;
      a.processed = imp.fakedTasks;
      const poi = this.map.pointsOfInterest.find((p) => p.id === imp.lastFakedPoiId);
      if (poi?.kind === "task") this.writeLogEntry(a, poi, true);
    }

    this.syncTaskBudget();

    this.perceive(dt);
    this.updateSabotage(dt);
    this.aiReportChecks();

    if (this.phase !== "playing") return;

    // The dead talk among themselves on their own one-voice-at-a-time channel.
    this.tickGhostChat();

    // Overtime: impatient traitors and a hard stop.
    if (this.time > OVERTIME_AT) {
      for (const a of this.actors) {
        if (a.role === "imposter" && a.alive) {
          a.killCooldown = Math.min(a.killCooldown, 12);
        }
      }
    }
    if (this.time > MATCH_LIMIT) {
      const progress = taskBarFraction({ total: this.taskTotal, complete: this.taskComplete });
      this.endMatch(
        progress >= 0.6 ? "crew" : "imposter",
        progress >= 0.6
          ? "Shift over — the crew kept the station running. Crew win."
          : "Shift over — the imposters outlasted the crew. Imposters win.",
      );
      return;
    }

    this.checkWin();
    if (this.phase !== "playing") this.activeTask = null;
  }

  // -- snapshot ------------------------------------------------------------

  private currentMeetingView(): MeetingView | null {
    const m = this.meeting;
    if (!m) return null;
    const living = this.living();
    const revealed = m.stage === "tally";
    return {
      stage: m.stage,
      secondsLeft: Math.max(0, Math.ceil(m.timer)),
      speaking: m.speaker?.name ?? null,
      reason:
        m.reason.kind === "emergency"
          ? "Emergency meeting"
          : "Body reported",
      messages: this.messages.filter((msg) => msg.t >= m.startedAt),
      speakers: living.map((a) => ({
        key: a.key,
        name: a.name,
        color: a.color,
        isPlayer: a.isPlayer,
        alive: a.alive,
        hasSpoken: m.spoken.has(a.key) || a.isPlayer,
        voted: m.votes[a.key] !== undefined,
      })),
      myVote: m.votes["player"] ?? null,
      votesRevealed: revealed,
      revealedVotes: revealed
        ? living.map((a) => ({
            key: a.key,
            name: a.name,
            targetName: m.votes[a.key] ? (this.names[m.votes[a.key] as string] ?? null) : null,
          }))
        : [],
      ejection:
        m.stage === "tally" && m.ejected
          ? {
              name: this.actor(m.ejected)?.name ?? m.ejected,
              isImposter: m.ejectedRole === "imposter",
            }
          : null,
    };
  }

  snapshot(): Snapshot {
    const me = this.playerActor;
    const holders = this.sabotage ? this.sabotageHolders() : new Map<string, Actor[]>();

    return {
      phase: this.phase,
      winner: this.winner,
      time: this.time,
      reveal: this.reveal ? this.reveal.map((r) => ({ ...r })) : null,
      role: me.role,
      playerName: me.name,
      playerAlive: me.alive,
      taskProgress: taskBarFraction({ total: this.taskTotal, complete: this.taskComplete }),
      tasks: me.tasks.map((t) => ({
        poiId: t.poiId,
        label: t.label,
        room: t.roomName,
        done: t.done,
      })),
      prompt: this.prompt(),
      killCooldown: me.killCooldown,
      sabotageCooldown: this.sabotageCooldown,
      sabotage: this.sabotage
        ? {
            kind: this.sabotage.kind,
            secondsLeft: Math.max(0, this.sabotage.secondsLeft),
            duration: this.sabotage.kind === "meltdown" ? MELTDOWN_TIME : BLACKOUT_TIME,
            fixPoiId: this.sabotage.fixPoiIds[0],
            fixProgress: Math.min(1, this.sabotage.fixProgress / REPAIR_TIME),
            fixPois: this.sabotage.fixPoiIds.map((id) => {
              const poi = this.map.pointsOfInterest.find((p) => p.id === id);
              return {
                id,
                label: poi?.label ?? id,
                room: poi ? roomAt(this.map, poi.x, poi.y).name : "",
                held: (holders.get(id)?.length ?? 0) > 0,
              };
            }),
          }
        : null,
      visionRange: this.visionRange,
      bodies: this.bodies.length,
      alive: { crew: this.living("crew").length, imposter: this.living("imposter").length },
      meeting: this.currentMeetingView(),
      log: [...this.log],
      llm: {
        enabled: this.llmEnabled,
        configured: Boolean(this.provider),
        provider: this.provider?.provider ?? null,
        calls: this.llmCalls,
        fallbacks: this.llmFallbacks,
        budget: this.ai.budget.remaining,
        roster: this.actors
          .filter((a) => !a.isPlayer)
          .map((a) => ({ key: a.key, name: a.name, model: a.cfg?.model ?? null })),
      },
      explored: this.vis.explored.reduce((n, v) => n + v, 0) / this.vis.explored.length,
      meetings: this.meetingsHeld,
      ejects: this.ejects,
      spectator: this.spectator,
      thoughts: [...this.thoughts],
      rawJsons: [...this.rawJsons],
      stationLog: [...this.stationLog],
      confessional: [...this.confessional],
      ghostChat: [...this.ghostChat],
      ghostMessages: this.ghostSpoken,
      ghostSpeaker: this.ghostSpeaker ? (this.names[this.ghostSpeaker] ?? this.ghostSpeaker) : null,
      channels: Object.values(CHANNELS),
      legacy: this.legacyView(),
      events: [...this.events],
      analyst: this.analystView
        ? this.actors
            .filter((a) => a.alive)
            .map((a) => {
              const top = rankSuspects(a.mind, 0)[0];
              return {
                key: a.key,
                name: a.name,
                color: a.color,
                top: top ? (this.names[top.key] ?? top.key) : "—",
                score: top ? top.score : 0,
              };
            })
        : null,
      activeTask: this.activeTask
        ? {
            poiId: this.activeTask.poiId,
            label: this.activeTask.label,
            room: this.activeTask.roomName,
            kind: minigameKind(this.activeTask.poiId),
          }
        : null,
    };
  }

  // -- cross-match memory --------------------------------------------------

  /**
   * The cross-match identity behind a seat: the model it runs on. Seat labels
   * ("Minimax M3-2") are display-only, so when a *different* model draws the
   * twin seat next shift the ledger still recognises every agent on the deck
   * instead of inventing a fresh one with no record. With no provider, each
   * seat is its own identity.
   */
  private identityOf(a: Actor): string {
    return a.cfg ? this.modelNameOf(a.cfg) : a.name;
  }

  /** The same mapping addressed by display name (ejections bank names). */
  private identityOfName(name: string): string {
    const actor = this.actors.find((x) => x.name === name);
    return actor ? this.identityOf(actor) : name;
  }

  /**
   * The ledger's view of this shift, for the end screen and the briefing: who
   * has played before, and who they still hold a grudge against.
   */
  legacyView(): LegacyView | null {
    if (!this.legacy || this.legacy.shifts === 0) return null;
    return {
      shifts: this.legacy.shifts,
      agents: this.actors
        .filter((a) => !a.isPlayer)
        .map((a) => {
          const record = this.legacy?.agents[this.identityOf(a)];
          return {
            name: a.name,
            games: record?.games ?? 0,
            wins: record?.wins ?? 0,
            eliminations: record?.eliminations ?? 0,
            grudges: Object.entries(record?.grudges ?? {})
              .sort((x, y) => y[1] - x[1])
              .map(([name]) => name),
          };
        }),
    };
  }

  /**
   * Everything the next shift's ledger needs from this one. The winning side is
   * read from `winner`, which is set before `onMatchEnd` fires.
   */
  legacySummary(): LegacyMatchSummary | null {
    if (!this.winner) return null;
    return {
      winner: this.winner,
      roster: this.actors.map((a) => ({ name: this.identityOf(a), role: a.role })),
      ejections: [...this.ejections],
    };
  }

  /** A copy of the structured match timeline, for the end-of-match recap. */
  matchEvents(): MatchEvent[] {
    return [...this.events];
  }

  /** Polygon for the fog layer — recomputed once per frame by the renderer. */
  visionPolygon(): Float32Array {
    return castVision(this.vis, this.player.x, this.player.y, this.visionRange);
  }
}
