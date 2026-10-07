/**
 * The seam between the React stage and a running match.
 *
 * `GameStage` used to drive a `GameEngine` directly. It now drives a *link*:
 * the same small surface (snapshot, frame, input, actions) implemented twice —
 *
 *  - `LocalGameLink` wraps an in-page engine and behaves exactly like the old
 *    client-only game (it is the offline fallback and the synchronous first
 *    render, so a page always has a full match to show);
 *  - `RemoteGameLink` (see `remoteLink.ts`) proxies the same surface to the
 *    autonomous match host over SSE, so the match keeps running server-side
 *    while the tab is closed and reattaches on reopen.
 *
 * Everything presentation-side (canvas, HUD, overlays) only ever sees a
 * `GameLink`, so the two modes cannot drift apart.
 */

import { GameEngine, type Snapshot } from "./engine";
import { foldMatch, loadLegacy, saveLegacy } from "./legacy";
import { saveMatch, type MatchRecord } from "./persistence";
import type { Player, MoveInput } from "./player";
import type { Crewmate } from "./crewmate";
import type { Imposter } from "./imposter";
import type { Body } from "./engine";
import type { VisibilityGrid } from "./vision";
import { buildMatchRecord } from "./record";
import type { CameraTarget } from "./render/renderMap";

export type LinkStatus = "local" | "connecting" | "live" | "offline";
export type Seat = "player" | "spectator";

/** One row of the briefing/end-screen roster. */
export interface ActorRow {
  key: string;
  name: string;
  color: string;
  isPlayer: boolean;
  role: "crew" | "imposter";
  model: string | null;
}

/**
 * Everything the canvas needs for one frame. Structurally a subset of the
 * renderer's `Scene`, so a frame can be spread straight into `drawMap`.
 */
export interface DrawScene {
  camera: CameraTarget | null;
  player: Player | null;
  playerAlive: boolean;
  crewmates: Crewmate[];
  imposters: Imposter[];
  bodies: readonly Body[];
  fog: { polygon: Float32Array; grid: VisibilityGrid } | null;
  revealRoles: boolean;
}

/** Callbacks the stage wires into whichever link it is driving. */
export interface GameLinkHandlers {
  /** The match history as the link knows it (local save or server list). */
  onHistory?: (records: MatchRecord[]) => void;
  /** Fired once per finished match. */
  onRecord?: (record: MatchRecord) => void;
}

export interface GameLink {
  readonly mode: "local" | "remote";
  readonly status: LinkStatus;
  /** Which seat this viewer holds on the match. */
  readonly seat: Seat;
  handlers: GameLinkHandlers;

  snapshot(): Snapshot;
  roster(): ActorRow[];
  /**
   * Advance the view by one animation frame and return what to draw.
   * Local links tick their engine here; remote links interpolate the latest
   * server states.
   */
  frame(nowMs: number): DrawScene;

  // -- input ---------------------------------------------------------------
  touchMove: MoveInput | null;
  setKey(key: string, down: boolean): void;
  clearKeys(): void;

  // -- actions -------------------------------------------------------------
  begin(spectate?: boolean): void;
  interact(): void;
  kill(): void;
  report(): void;
  sabotage(): void;
  say(text: string): void;
  vote(targetKey: string | null): void;
  advanceMeeting(): void;
  completeTask(): void;
  failTask(): void;
  enterSpectator(): void;
  analyst: boolean;
  restart(asImposter: boolean): void;

  /** Live peeks used right after an action, before the next snapshot lands. */
  readonly taskOpen: boolean;
  readonly meetingOpen: boolean;

  dispose(): void;
}

function rosterOf(engine: GameEngine): ActorRow[] {
  return engine.actors.map((a) => ({
    key: a.key,
    name: a.name,
    color: a.color,
    isPlayer: a.isPlayer,
    role: a.role,
    model: a.cfg?.model ?? null,
  }));
}

/**
 * The in-page match: exactly the client-only behaviour the game shipped with.
 * It owns record saving and the browser-local legacy fold, so an offline run
 * still writes history and learns between shifts in this browser.
 */
export class LocalGameLink implements GameLink {
  readonly mode = "local" as const;
  status: LinkStatus = "local";
  readonly seat: Seat = "player";
  handlers: GameLinkHandlers = {};

  private engineInstance: GameEngine;
  private last = 0;

  constructor(opts: { playerIsImposter?: boolean } = {}) {
    this.engineInstance = new GameEngine(opts);
    this.wire();
  }

  get engine(): GameEngine {
    return this.engineInstance;
  }

  private wire(): void {
    this.engineInstance.onMatchEnd = (winner) => {
      const record = buildMatchRecord(this.engineInstance, winner);
      // Carry this shift into the ledger the next one reads: wins, eliminations
      // and — the interesting part — the grudges an innocent takes away from
      // everyone who voted them out.
      const summary = this.engineInstance.legacySummary();
      if (summary) saveLegacy(foldMatch(loadLegacy(), summary));
      this.handlers.onHistory?.(saveMatch(record));
      this.handlers.onRecord?.(record);
    };
  }

  snapshot(): Snapshot {
    return this.engineInstance.snapshot();
  }

  roster(): ActorRow[] {
    return rosterOf(this.engineInstance);
  }

  frame(nowMs: number): DrawScene {
    if (this.last === 0) this.last = nowMs;
    const dt = Math.min((nowMs - this.last) / 1000, 0.05);
    this.last = nowMs;
    const engine = this.engineInstance;
    engine.tick(dt);

    const alive = new Set(engine.actors.filter((a) => a.alive).map((a) => a.entity));
    return {
      camera: engine.spectator ? null : { x: engine.player.x, y: engine.player.y },
      player: engine.spectator ? null : engine.player,
      playerAlive: engine.playerActor.alive,
      crewmates: engine.crewmates.filter((c) => alive.has(c)),
      imposters: engine.imposters.filter((i) => alive.has(i)),
      bodies: engine.bodies,
      fog:
        engine.phase === "playing" && !engine.spectator
          ? { polygon: engine.visionPolygon(), grid: engine.vis }
          : null,
      revealRoles: engine.analystView,
    };
  }

  get touchMove(): MoveInput | null {
    return this.engineInstance.touchMove;
  }
  set touchMove(v: MoveInput | null) {
    this.engineInstance.touchMove = v;
  }

  setKey(key: string, down: boolean): void {
    this.engineInstance.setKey(key, down);
  }

  clearKeys(): void {
    for (const k of [...this.engineInstance.keys]) this.engineInstance.setKey(k, false);
    this.engineInstance.touchMove = null;
  }

  begin(spectate = false): void {
    this.engineInstance.begin(spectate);
  }
  interact(): void {
    this.engineInstance.interact();
  }
  kill(): void {
    this.engineInstance.playerKill();
  }
  report(): void {
    this.engineInstance.report();
  }
  sabotage(): void {
    this.engineInstance.triggerSabotage();
  }
  say(text: string): void {
    this.engineInstance.playerSay(text);
  }
  vote(targetKey: string | null): void {
    this.engineInstance.playerVote(targetKey);
  }
  advanceMeeting(): void {
    this.engineInstance.advanceMeeting();
  }
  completeTask(): void {
    this.engineInstance.completeActiveTask();
  }
  failTask(): void {
    this.engineInstance.cancelActiveTask();
  }
  enterSpectator(): void {
    this.engineInstance.enterSpectator();
  }

  get analyst(): boolean {
    return this.engineInstance.analystView;
  }
  set analyst(on: boolean) {
    this.engineInstance.analystView = on;
  }

  restart(asImposter: boolean): void {
    // A fresh engine re-reads the ledger, so the grudges this match just banked
    // are already in the next roster's heads.
    this.engineInstance = new GameEngine({ playerIsImposter: asImposter });
    this.wire();
    this.last = 0;
  }

  get taskOpen(): boolean {
    return this.engineInstance.activeTask !== null;
  }
  get meetingOpen(): boolean {
    return this.engineInstance.meeting !== null;
  }

  dispose(): void {
    this.engineInstance.onMatchEnd = null;
  }
}

/** Shared roster builder, also used by the host when building wire messages. */
export { rosterOf };
