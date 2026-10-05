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
  crewmateWorkAt,
  updateCrewmate,
  type Crewmate,
} from "./crewmate";
import { heuristicStatement, type NameIndex, type Statement } from "./dialogue";
import {
  createImposters,
  imposterFakeTask,
  imposterGotoPoint,
  imposterHalt,
  imposterSeekVent,
  imposterStalk,
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
  bump,
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
export const MELTDOWN_TIME = 45;
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
const LLM_BUDGET = 150;

export type Phase = "briefing" | "playing" | "meeting" | "ended";
export type Winner = "crew" | "imposter" | null;
export type SabotageKind = "meltdown" | "blackout";

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
  kind: "statement" | "system" | "player";
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

export type EntityKind = "player" | "crew" | "imposter";

export interface Actor {
  key: string;
  name: string;
  color: string;
  role: "crew" | "imposter";
  kind: EntityKind;
  isPlayer: boolean;
  alive: boolean;
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
  repathAt: number;
  killCooldown: number;
  /** Time until which this agent counts as actively repairing a sabotage. */
  fixUntil: number;
  speakAt: number;
  voteAt: number;
}

interface MeetingState {
  startedAt: number;
  stage: "discussion" | "voting" | "tally";
  timer: number;
  reason: { kind: "emergency" | "report"; byKey: string };
  votes: Record<string, string | null>;
  ejected: string | null;
  ejectedRole: "crew" | "imposter" | null;
  playerLine: string | null;
  spoken: Set<string>;
  /** Index into `messages` where this meeting's transcript begins. */
  msgStart: number;
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
  reason: string;
  messages: ChatMessage[];
  speakers: SpeakerView[];
  myVote: string | null;
  votesRevealed: boolean;
  revealedVotes: RevealedVote[];
  ejection: { name: string; isImposter: boolean } | null;
}

export interface Snapshot {
  phase: Phase;
  winner: Winner;
  time: number;
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
}

export interface EngineOptions {
  map?: GameMap;
  seed?: number;
  playerIsImposter?: boolean;
  llm?: boolean;
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

  meeting: MeetingState | null = null;
  meetingsHeld = 0;
  ejects = 0;

  sabotage: { kind: SabotageKind; secondsLeft: number; fixPoiIds: string[]; fixProgress: number } | null = null;
  sabotageCooldown = 0;
  /** Emergency beacon lockout after a meeting, so respawns can't chain them. */
  emergencyCooldown = 0;

  keys = new Set<string>();
  /** Analog movement vector from the on-screen joystick (touch devices). */
  touchMove: MoveInput | null = null;
  log: string[] = [];
  messages: ChatMessage[] = [];

  analystView = false;
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

  constructor(opts: EngineOptions = {}) {
    this.map = opts.map ?? DEFAULT_MAP;
    this.grid = buildNavGrid(this.map);
    this.zones = buildZoneGraph(this.map);
    this.vis = buildVisibilityGrid(this.map);
    this.los = makeLosTest(this.map);
    this.rng = makeRng(opts.seed ?? 20260410);
    this.llmEnabled = opts.llm ?? true;
    this.provider = activeProvider();
    this.ai = { cfg: null, gate: new RequestGate(300, 3), budget: { remaining: LLM_BUDGET } };

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

    const playerMind = createMind("player", playerRole, playerIsImposter ? imposterKeys : []);

    this.actors = [
      {
        key: "player",
        name: "ORION",
        color: this.player.color,
        role: playerRole,
        kind: "player",
        isPlayer: true,
        alive: true,
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
        repathAt: 0,
        killCooldown: 0,
        fixUntil: 0,
        speakAt: 0,
        voteAt: 0,
      },
      ...this.crewmates.map((e, i) => this.makeActor(`crew:${i}`, e, "crew", i)),
      ...this.imposters.map((e, i) =>
        this.makeActor(`imp:${i}`, e, "imposter", this.crewmates.length + i),
      ),
    ];

    // Imposters know each other; that secrecy is what makes them dangerous.
    const allies = this.actors.filter((a) => a.role === "imposter").map((a) => a.key);
    for (const a of this.actors) {
      if (a.role === "imposter") a.mind.allies = allies.filter((k) => k !== a.key);
    }

    if (playerRole === "crew") {
      this.playerTasks = assignTasks(this.map, PLAYER_TASKS, 3);
      this.actors[0].tasks = this.playerTasks;
    }

    // AI crew get an explicit list too, so the shared bar is exactly reachable
    // and each agent has a real reason to keep walking back to a console. The
    // slices are deliberately disjoint: agents that chase the same console end
    // up side by side, and then nobody is ever alone enough to be killed.
    this.actors.forEach((a, idx) => {
      if (a.kind === "crew") a.tasks = assignTasks(this.map, TASKS_PER_CREW, idx * TASKS_PER_CREW);
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
  ): Actor {
    return {
      key,
      name: entity.name,
      color: entity.color,
      role,
      kind: role === "crew" ? "crew" : "imposter",
      isPlayer: false,
      alive: true,
      zoneId: "",
      entity,
      mind: createMind(key, role),
      cfg: this.modelFor(index),
      tasks: [],
      processed: 0,
      counted: 0,
      nextDecisionAt: 1 + this.rng.range(0, 4),
      decisionSeq: 0,
      pendingDecision: false,
      urgencyAt: 0,
      actionFeedback: null,
      bodyToReport: null,
      repathAt: 0,
      killCooldown: role === "imposter" ? 34 : 0,
      fixUntil: 0,
      speakAt: 0,
      voteAt: 0,
    };
  }

  /**
   * Bind agent `index` to its own model from the active provider's cheap pool.
   * The pool is walked in order and wrapped only if it runs short, so in the
   * normal 4-crew + 2-imposter match every AI player is a different model.
   */
  private modelFor(index: number): LlmConfig | null {
    if (!this.provider || this.provider.models.length === 0) return null;
    const model = this.provider.models[index % this.provider.models.length];
    return configFor(this.provider, model);
  }

  /** Per-agent decision context: its own endpoint, the shared gate and budget. */
  private contextFor(a: Actor): AiContext {
    return { cfg: a.cfg, gate: this.ai.gate, budget: this.ai.budget };
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
    return this.actors.filter((a) => a.alive && (!role || a.role === role));
  }

  private note(text: string): void {
    this.log.push(text);
    if (this.log.length > 6) this.log.shift();
  }

  private say(a: Actor, text: string, kind: ChatMessage["kind"] = "statement"): void {
    this.messages.push({
      id: this.nextMsgId++,
      t: this.time,
      speakerKey: a.key,
      speakerName: a.name,
      color: a.color,
      text,
      kind,
    });
  }

  private system(text: string): void {
    this.messages.push({
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

  begin(): void {
    if (this.phase !== "briefing") return;
    this.phase = "playing";
    this.startedAt = Date.now();
    this.system("Match started — find the imposters or finish the tasks.");
  }

  toggleLlm(on: boolean): void {
    this.llmEnabled = on;
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

        // Watching someone climb into a vent is the strongest possible tell.
        if (tgt.role === "imposter" && !obs.mind.ventsSeen.has(tgt.key)) {
          const vent = nearestPoi(this.map, "vent", tgt.entity.x, tgt.entity.y);
          if (vent && Math.hypot(vent.x - tgt.entity.x, vent.y - tgt.entity.y) < 46) {
            obs.mind.ventsSeen.add(tgt.key);
            remember(obs.mind, {
              t,
              kind: "vent",
              actorKey: tgt.key,
              roomId: room.id,
              text: `${tgt.name} used a vent in ${room.name}.`,
            });
            bump(obs.mind, tgt.key, 0.6);
          }
        }
      }

      for (const b of this.bodies) {
        if (obs.mind.bodiesSeen.has(b.id)) continue;
        if (!this.visible(obs, b.x, b.y)) continue;
        obs.mind.bodiesSeen.add(b.id);
        remember(obs.mind, {
          t,
          kind: "body",
          actorKey: b.key,
          roomId: b.roomId,
          text: `Found ${b.name}'s body in ${roomAt(this.map, b.x, b.y).name}.`,
        });

        // Someone loitering over the corpse is the obvious suspect.
        for (const other of this.actors) {
          if (other === obs || !other.alive) continue;
          if (Math.hypot(other.entity.x - b.x, other.entity.y - b.y) > 80) continue;
          if (!this.los(b.x, b.y, other.entity.x, other.entity.y)) continue;
          bump(obs.mind, other.key, 0.35);
        }

        // Inference, not observation: whoever this agent last saw heading into
        // this room shortly before the discovery is the strongest lead there is.
        // Only the most recent sighting gets the full weight — the rest is just
        // noise from people who happened to be in the same room.
        let bestKey: string | null = null;
        let bestAt = -Infinity;
        for (const [key, seen] of Object.entries(obs.mind.lastSeen)) {
          if (key === obs.key || key === b.key) continue;
          if (seen.roomId !== b.roomId) continue;
          if (t - seen.t > 60) continue;
          bump(obs.mind, key, 0.1);
          if (seen.t > bestAt) {
            bestAt = seen.t;
            bestKey = key;
          }
        }
        if (bestKey) bump(obs.mind, bestKey, 0.42);

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

    victim.alive = false;
    if (victim.kind === "crew") {
      const c = victim.entity as Crewmate;
      crewmateHalt(c);
      c.x = -9999;
      c.y = -9999;
    }
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
    this.system(`${victim.name} was killed in ${roomAt(this.map, vx, vy).name}.`);

    for (const w of witnesses) {
      remember(w.mind, {
        t: this.time,
        kind: "kill",
        actorKey: killer.key,
        roomId,
        text: `Watched ${killer.name} kill ${victim.name}.`,
      });
      bump(w.mind, killer.key, 0.95);
      if (!w.isPlayer && w.role === "crew") {
        w.bodyToReport = body.id;
        w.repathAt = 0;
      }
    }

    if (victim.isPlayer) this.note("You are dead — spectate and watch the others.");
    this.syncTaskBudget();
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
    const chosen: SabotageKind =
      kind ?? (this.rng.chance(0.5) ? "meltdown" : "blackout");

    if (chosen === "meltdown") {
      this.sabotage = {
        kind: "meltdown",
        secondsLeft: MELTDOWN_TIME,
        fixPoiIds: ["sab_reactor", "sab_life"],
        fixProgress: 0,
      };
      this.system("SABOTAGE: reactor meltdown — repair at the reactor or life support.");
    } else {
      this.sabotage = {
        kind: "blackout",
        secondsLeft: BLACKOUT_TIME,
        fixPoiIds: ["sab_power"],
        fixProgress: 0,
      };
      this.system("SABOTAGE: grid overload — lights are down, repair at the power bay.");
    }
    this.sabotageCooldown = SABOTAGE_COOLDOWN;
    return true;
  }

  private updateSabotage(dt: number): void {
    if (this.sabotageCooldown > 0) this.sabotageCooldown = Math.max(0, this.sabotageCooldown - dt);
    if (this.emergencyCooldown > 0) {
      this.emergencyCooldown = Math.max(0, this.emergencyCooldown - dt);
    }
    if (!this.sabotage) return;

    this.sabotage.secondsLeft -= dt;

    const fixables = this.living().filter((a) => a.role === "crew");
    let workers = 0;
    for (const a of fixables) {
      if (a.isPlayer) {
        if (!this.keys.has("e")) continue;
      } else if (a.fixUntil <= this.time) {
        // An AI only repairs after it has chosen and validated a FIX interaction.
        continue;
      }
      const near = this.sabotage.fixPoiIds.some((id) => {
        const poi = this.map.pointsOfInterest.find((p) => p.id === id);
        return poi ? Math.hypot(poi.x - a.entity.x, poi.y - a.entity.y) <= INTERACT_RANGE : false;
      });
      if (near) workers++;
    }

    if (workers > 0) {
      this.sabotage.fixProgress += dt * (1 + 0.6 * (workers - 1));
      if (this.sabotage.fixProgress >= REPAIR_TIME) {
        const kind = this.sabotage.kind;
        this.sabotage = null;
        this.system(`Sabotage repaired${kind === "blackout" ? " — lights restored" : ""}.`);
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
    }
  }

  // -- AI decisions --------------------------------------------------------

  /** How alone `target` is: distance to the nearest other living actor. */
  private isolationOf(target: Actor, exclude: Actor): number {
    let best = Infinity;
    for (const other of this.actors) {
      if (other === target || other === exclude || !other.alive) continue;
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
      if (this.sabotage) {
        for (const id of this.sabotage.fixPoiIds) {
          const poi = this.map.pointsOfInterest.find((p) => p.id === id);
          if (!poi || (!here(poi.x, poi.y) && !sees(poi.x, poi.y))) continue;
          out.push({
            id: poi.id,
            type: "FIX",
            name: poi.label,
            status: "active",
            in_range: sees(poi.x, poi.y),
          });
        }
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
      out.push({
        id: beacon.id,
        type: "EMERGENCY",
        name: "Emergency beacon",
        status:
          this.emergencyCooldown > 0
            ? `recharging ${Math.ceil(this.emergencyCooldown)}s`
            : "ready",
        in_range: sees(beacon.x, beacon.y) && this.emergencyCooldown <= 0,
      });
    }

    return out;
  }

  private buildView(a: Actor): WorldView {
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

    const others = this.actors
      .filter((o) => o !== a)
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
          alive: o.alive,
          visible: o.alive && this.visible(a, o.entity.x, o.entity.y),
          /** Distance from this actor to its nearest other companion. */
          isolation: o.alive ? this.isolationOf(o, a) : 0,
          /** A fellow traitor is never a target or a suspect. */
          allied: a.mind.allies.includes(o.key),
        };
      });

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

    const fixPoiId = this.sabotage?.fixPoiIds[0] ?? "";
    const fixPoi = this.map.pointsOfInterest.find((p) => p.id === fixPoiId);

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
      visible_players: others.filter((o) => o.alive && o.visible).map((o) => o.name),
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
      vents: this.map.pointsOfInterest.filter((p) => p.kind === "vent").map((p) => p.id),
      interactables: this.buildInteractables(a, zone),
      system_message: feedback,
      others,
      history,
      decision_history: decisionHistory,
      suspicions: rankSuspects(a.mind, 0)
        .slice(0, 5)
        .map((s) => ({ name: this.names[s.key] ?? s.key, score: s.score })),
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
      sabotage: this.sabotage && fixPoi
        ? {
            kind: this.sabotage.kind,
            secondsLeft: this.sabotage.secondsLeft,
            fixPoiId,
            fixRoomId: fixPoi.roomId,
          }
        : null,
      cooldowns: { kill: a.killCooldown, sabotage: this.sabotageCooldown },
      bodyOutstanding: this.bodies.length > 0,
      taskProgress: taskBarFraction({ total: this.taskTotal, complete: this.taskComplete }),
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

    // Don't interrupt an agent that is mid-task: re-pathing a crewmate that is
    // already standing at its console would cancel the work every cycle and the
    // task bar would never move. Sabotage is the one thing worth interrupting for.
    if (a.kind === "crew" && !this.sabotage) {
      const c = a.entity as Crewmate;
      const productive =
        c.state === "working" || (c.state === "moving" && c.targetPoiId !== null);
      if (productive) {
        a.nextDecisionAt = this.time + 2.5;
        return;
      }
    }

    const view = this.buildView(a);
    const nextIn = a.role === "imposter" ? this.rng.range(7, 11) : this.rng.range(10, 16);
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
              this.applyIntent(a, intent);
            }
          } else {
            this.llmFallbacks++;
            if (this.phase === "playing" && a.alive) this.applyIntent(a, heuristicIntent(view, () => this.rng.next()));
          }
        })
        .catch(() => {
          a.pendingDecision = false;
          this.llmFallbacks++;
        });
      return;
    }

    this.applyIntent(a, heuristicIntent(view, () => this.rng.next()));
  }

  /**
   * Translate the model's node-graph decision into physical movement or a
   * validated interaction. `MOVE` resolves a destination zone and lets A* walk
   * the sprite to it; `INTERACT` is refused or executed by the engine referee;
   * `VENT` and `SABOTAGE` are the traitor's engine-owned abilities.
   */
  private applyIntent(a: Actor, intent: Intent): void {
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
      this.recordDecision(a, `${verb} in ${here}`, `${verb} (${intent.target})`, intent.reasoning);
      const failure = this.executeInteraction(a, intent);
      // A failed action never happens; instead the reason is attached to the
      // agent and delivered as `system_message` on its next decision.
      if (failure) a.actionFeedback = `Action Failed: ${failure}`;
      return;
    }

    if (intent.action === "SABOTAGE") {
      if (a.role === "imposter") {
        this.recordDecision(a, "Sabotage the station to split the crew", "Triggered a sabotage", intent.reasoning);
        this.triggerSabotage();
      }
      return;
    }

    if (intent.action === "VENT") {
      if (a.kind !== "imposter") return;
      const imp = a.entity as Imposter;
      const requested =
        intent.target &&
        this.map.pointsOfInterest.some((p) => p.id === intent.target && p.kind === "vent")
          ? intent.target
          : null;
      const vent = requested ?? nearestPoi(this.map, "vent", imp.x, imp.y)?.id ?? null;
      if (vent) {
        this.recordDecision(a, "Slip into a vent to travel unseen", "Headed for a vent", intent.reasoning);
        imposterSeekVent(imp, this.map, this.grid, vent);
      }
      return;
    }

    const zone = zoneByRef(this.zones, intent.target);
    if (!zone) return;
    a.mind.lastMove = zone.name;

    if (a.kind === "crew") {
      const c = a.entity as Crewmate;
      // A live sabotage outranks routine work: head for the repair panel even
      // if this room also holds a console the agent still owes.
      if (this.sabotage) {
        const fix = this.map.pointsOfInterest.find(
          (p) =>
            this.sabotage !== null &&
            this.sabotage.fixPoiIds.includes(p.id) &&
            zoneAtPoint(this.zones, this.map, p.x, p.y).id === zone.id,
        );
        if (fix) {
          this.recordDecision(
            a,
            `Repair the ${this.sabotage.kind} in ${zone.name}`,
            `Moving to ${zone.name} to repair the sabotage`,
            intent.reasoning,
          );
          crewmateGotoPoi(c, this.map, this.grid, fix.id);
          return;
        }
      }
      // Productive movement: if this zone holds a console the agent still owes
      // work at, path straight to that console so arrival starts the task.
      const owed = zone.taskPoiIds.find((id) =>
        a.tasks.some((t) => t.poiId === id && !t.done),
      );
      if (owed) {
        const label = a.tasks.find((t) => t.poiId === owed)?.label ?? owed;
        this.recordDecision(
          a,
          `Work "${label}" in ${zone.name}`,
          `Moving to ${zone.name} for "${label}"`,
          intent.reasoning,
        );
        crewmateGotoPoi(c, this.map, this.grid, owed);
        return;
      }
      this.recordDecision(a, `Move to ${zone.name}`, `Moving to ${zone.name}`, intent.reasoning);
      const pt = standPoint(this.map, zone);
      crewmateGotoPoint(c, this.grid, pt.x, pt.y);
      return;
    }

    if (a.kind !== "imposter") return;
    const imp = a.entity as Imposter;

    // Chase an AI crewmate who is currently in the destination zone.
    const prey = this.actors.find(
      (o) => o.kind === "crew" && o.alive && o.zoneId === zone.id,
    );
    if (prey) {
      this.recordDecision(
        a,
        `Stalk ${prey.name} in ${zone.name}`,
        `Stalking ${prey.name}`,
        intent.reasoning,
      );
      imposterStalk(imp, this.grid, this.crewmates, (prey.entity as Crewmate).id);
      return;
    }
    // The human player is not a Crewmate, so walk at their position directly.
    const human = this.playerActor;
    if (human.alive && human.role === "crew" && human.zoneId === zone.id) {
      this.recordDecision(
        a,
        `Close on the player in ${zone.name}`,
        "Chasing the player",
        intent.reasoning,
      );
      imposterGotoPoint(imp, this.grid, human.entity.x, human.entity.y);
      return;
    }
    // Otherwise stand at a console in the zone for cover, or just walk there.
    if (zone.taskPoiIds.length > 0) {
      const label =
        this.map.pointsOfInterest.find((p) => p.id === zone.taskPoiIds[0])?.label ??
        zone.taskPoiIds[0];
      this.recordDecision(
        a,
        `Fake work at "${label}" in ${zone.name} (alibi)`,
        `Heading to fake a task in ${zone.name}`,
        intent.reasoning,
      );
      imposterFakeTask(imp, this.map, this.grid, zone.taskPoiIds[0]);
      return;
    }
    this.recordDecision(a, `Move to ${zone.name}`, `Moving to ${zone.name}`, intent.reasoning);
    const pt = standPoint(this.map, zone);
    imposterGotoPoint(imp, this.grid, pt.x, pt.y);
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
  ): void {
    setGoal(a.mind, goal, this.time, reasoning ?? null, action);
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
        if (a.role !== "crew") return "you cannot repair the sabotage.";
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
        a.fixUntil = this.time + REPAIR_TIME + 2;
        this.haltActor(a);
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

  // -- reporting -----------------------------------------------------------

  private startMeeting(reason: { kind: "emergency" | "report"; byKey: string }): void {
    if (this.phase !== "playing") return;
    const by = this.actor(reason.byKey);
    if (!by) return;

    this.phase = "meeting";
    this.meetingsHeld++;
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
    const meeting: MeetingState = {
      startedAt: this.time,
      stage: "discussion",
      timer: DISCUSSION_TIME,
      reason,
      votes: {},
      ejected: null,
      ejectedRole: null,
      playerLine: null,
      spoken: new Set(),
      msgStart: this.messages.length,
    };

    let i = 0;
    for (const a of living) {
      if (a.isPlayer) continue;
      a.speakAt = this.time + 1.4 + i * 2.1 + this.rng.range(0, 1.2);
      a.voteAt = 0;
      i++;
    }

    this.meeting = meeting;
    // Everyone respawns metres from the beacon — without a lockout the very
    // next keypress would call another meeting.
    this.emergencyCooldown = 45;
    this.system(
      reason.kind === "emergency"
        ? `${by.name} called an emergency meeting.`
        : `${by.name} reported a body.`,
    );
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
      for (const a of living) {
        if (a.isPlayer || m.spoken.has(a.key)) continue;
        if (this.time >= a.speakAt) {
          m.spoken.add(a.key);
          this.speak(a, m);
        }
      }
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

  private openVoting(m: MeetingState, living: Actor[]): void {
    if (m.stage !== "discussion") return;
    m.stage = "voting";
    m.timer = VOTING_TIME;
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

  private speak(a: Actor, m: MeetingState): void {
    const input = {
      others: this.living().map((x) => x.key),
      playerLine: m.playerLine,
    };

    const post = (stmt: Statement): void => {
      if (this.phase !== "meeting") return;
      this.say(a, stmt.line);
      if (stmt.accuse) this.applyAccusation(a, stmt.accuse, m);
    };

    if (this.llmEnabled && a.cfg) {
      void statementWithModel(this.contextFor(a), this.map, a.mind, { key: a.key, name: a.name }, this.names, {
        ...input,
        bodiesFound: this.bodies.length,
        ejectedSoFar: [],
      })
        .then((stmt) => {
          if (stmt) {
            this.llmCalls++;
            post(stmt);
          } else {
            this.llmFallbacks++;
            post(fallbackStatement(this.map, a.mind, { key: a.key, name: a.name }, this.names, input));
          }
        })
        .catch(() => {
          this.llmFallbacks++;
          post(fallbackStatement(this.map, a.mind, { key: a.key, name: a.name }, this.names, input));
        });
      return;
    }

    post(heuristicStatement(this.map, a.mind, { key: a.key, name: a.name }, this.names, input));
  }

  /** Listeners adjust their beliefs when someone accuses someone else. */
  private applyAccusation(speaker: Actor, target: string, m: MeetingState): void {
    void m;
    for (const listener of this.living()) {
      if (listener === speaker) continue;
      if (listener.role === "imposter") {
        // Being pointed at is dangerous; so is anyone who points at your ally.
        const accusedIsAlly = listener.mind.allies.includes(target);
        bump(listener.mind, speaker.key, accusedIsAlly ? 0.5 : 0.18);
      } else {
        bump(listener.mind, target, 0.07);
      }
    }
  }

  playerSay(text: string): void {
    const m = this.meeting;
    if (!m || m.stage !== "discussion") return;
    const trimmed = text.trim().slice(0, 200);
    if (!trimmed) return;
    const me = this.playerActor;
    m.playerLine = trimmed;
    this.say(me, trimmed, "player");
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
    const m = this.meeting;
    if (!m || m.stage !== "voting") return;
    m.votes["player"] = targetKey;
  }

  private resolveVote(m: MeetingState, living: Actor[]): void {
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

    ejected.alive = false;
    if (ejected.kind === "crew") {
      const c = ejected.entity as Crewmate;
      crewmateHalt(c);
      c.x = -9999;
      c.y = -9999;
    }
    if (ejected.kind === "imposter") {
      imposterHalt(ejected.entity as Imposter);
      const i = ejected.entity as Imposter;
      i.x = -9999;
      i.y = -9999;
    }

    this.ejects++;
    m.ejected = ejected.key;
    m.ejectedRole = ejected.role;
    this.syncTaskBudget();

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
  private recordMeetingMemory(m: MeetingState): void {
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
    this.onMatchEnd?.(winner);
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
    if (!me.alive) return "SPECTATING — you are dead";

    const nearBody = this.bodies.some(
      (b) => Math.hypot(b.x - this.player.x, b.y - this.player.y) <= INTERACT_RANGE,
    );
    const parts: string[] = [];
    if (nearBody) parts.push("R — report body");

    const poi = this.nearestInteractable();
    if (poi) {
      if (poi.kind === "emergency") {
        parts.push(
          this.emergencyCooldown > 0
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
        parts.push(`HOLD E — repair (${Math.round(this.sabotage.fixProgress * 100)}%)`);
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
    updatePlayer(this.map, this.player, this.moveInput(), dt);
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
    for (const i of livingImps) updateImposter(this.map, this.grid, i, livingCrew, dt);

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
      if (poi?.kind !== "task") continue;
      if (a.counted >= TASKS_PER_CREW) continue;
      a.counted++;
      this.taskComplete = Math.min(this.taskTotal, this.taskComplete + 1);
      if (this.taskComplete >= this.taskTotal) this.checkWin();
    }

    this.syncTaskBudget();

    this.perceive(dt);
    this.updateSabotage(dt);
    this.aiReportChecks();

    if (this.phase !== "playing") return;

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

    return {
      phase: this.phase,
      winner: this.winner,
      time: this.time,
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

  /** Polygon for the fog layer — recomputed once per frame by the renderer. */
  visionPolygon(): Float32Array {
    return castVision(this.vis, this.player.x, this.player.y, this.visionRange);
  }
}
