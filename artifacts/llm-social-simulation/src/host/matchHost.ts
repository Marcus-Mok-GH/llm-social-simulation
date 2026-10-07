/**
 * The autonomous match host.
 *
 * One `GameEngine` runs here, ticked on a timer, whether or not anyone is
 * looking: the shift starts on its own, plays itself while the tab is closed
 * (via the AFK pilot), folds its outcome into the cross-match ledger, writes
 * the record to the shared history, and starts the next shift. Viewers attach
 * over SSE, claim the single player seat by session id (so a rejoining tab
 * takes its own body back), and drive it through the same actions a local
 * player would.
 *
 * The host owns no transport: `attach` takes anything that can `send` a
 * `ServerMsg`, so the HTTP/SSE layer in `main.ts` and the headless test are
 * the same client from here.
 */

import { GameEngine } from "../game/engine";
import { foldMatch, type LegacyLedger } from "../game/legacy";
import { rosterOf, type Seat } from "../game/link";
import type { MatchRecord } from "../game/persistence";
import { buildMatchRecord } from "../game/record";
import { AfkPilot } from "./afkPilot";
import {
  encodeExplored,
  type ClientMsg,
  type HelloMsg,
  type ServerMsg,
  type StateMsg,
} from "./protocol";
import type { HostStore } from "./store";

export interface Viewer {
  session: string;
  /** Distinguishes a reconnect from the connection it replaced. */
  token: string;
  send: (msg: ServerMsg) => void;
}

export interface MatchHostOptions {
  /** Milliseconds a fresh briefing waits before the shift starts itself. */
  autoBeginMs?: number;
  /** Milliseconds the end screen lingers before the next shift is built. */
  intermissionMs?: number;
  /** How often viewers get a state frame. */
  broadcastMs?: number;
  historyLimit?: number;
  /** Role the *next* shift hands the human; flips when the end screen asks. */
  playerIsImposter?: boolean;
}

export class MatchHost {
  engine!: GameEngine;
  matchId = "";

  readonly broadcastMs: number;
  private readonly autoBeginMs: number;
  private readonly intermissionMs: number;
  private readonly historyLimit: number;

  private readonly store: HostStore;
  private ledger: LegacyLedger;
  private history: MatchRecord[];

  private viewers = new Map<string, Viewer>();
  private playerSession: string | null = null;
  private readonly pilot = new AfkPilot();

  private matchNo = 0;
  private seq = 0;
  private createdWall = 0;
  private endedWall: number | null = null;
  private nextPlayerIsImposter: boolean;
  private lastExploredJson: string | null = null;
  private lastExploredSentAt = 0;

  constructor(store: HostStore, opts: MatchHostOptions = {}) {
    this.store = store;
    this.ledger = store.loadLedger();
    this.history = store.loadHistory();
    this.autoBeginMs = opts.autoBeginMs ?? 9000;
    this.intermissionMs = opts.intermissionMs ?? 8000;
    this.broadcastMs = opts.broadcastMs ?? 100;
    this.historyLimit = opts.historyLimit ?? 12;
    this.nextPlayerIsImposter = opts.playerIsImposter ?? false;
    this.startMatch();
  }

  // -- match lifecycle -------------------------------------------------------

  startMatch(): void {
    this.matchNo++;
    this.engine = new GameEngine({
      playerIsImposter: this.nextPlayerIsImposter,
      legacyLedger: this.ledger,
      // Local play has always run on the default seed; autonomous shifts vary
      // it so back-to-back matches are not the same story on repeat.
      seed: (Date.now() ^ (this.matchNo * 7919)) >>> 0,
    });
    this.matchId = `shift-${Date.now().toString(36)}-${this.matchNo}`;
    this.seq = 0;
    this.createdWall = Date.now();
    this.endedWall = null;
    this.lastExploredJson = null;
    this.lastExploredSentAt = 0;
    this.pilot.reset();
    this.engine.keys.clear();
    this.engine.touchMove = null;
    this.engine.onMatchEnd = (winner) => this.onMatchEnd(winner);
    this.broadcastState();
  }

  private onMatchEnd(winner: "crew" | "imposter"): void {
    const record = buildMatchRecord(this.engine, winner);
    this.history = [record, ...this.history.filter((m) => m.id !== record.id)].slice(
      0,
      this.historyLimit,
    );
    this.store.saveHistory(this.history);
    // The learning: every autonomous shift — watched or not — folds into the
    // ledger the next roster reads on construction.
    const summary = this.engine.legacySummary();
    if (summary) {
      this.ledger = foldMatch(this.ledger, summary);
      this.store.saveLedger(this.ledger);
    }
    this.endedWall = Date.now();
    this.broadcast({ type: "record", history: this.history });
  }

  /**
   * Advance the world by one tick. `now` is injectable so the headless test
   * can move the auto-begin/intermission clocks without sleeping.
   */
  pump(dt: number, now: number = Date.now()): void {
    const e = this.engine;

    if (e.phase === "briefing" && now - this.createdWall >= this.autoBeginMs) {
      e.begin();
    }
    if (
      e.phase === "ended" &&
      this.endedWall !== null &&
      now - this.endedWall >= this.intermissionMs
    ) {
      this.startMatch();
      return;
    }
    if (e.phase === "playing") {
      const seatTaken =
        this.playerSession !== null && this.viewers.has(this.playerSession);
      if (!seatTaken) this.pilot.tick(e, dt);
    }
    e.tick(dt);
  }

  // -- viewers ---------------------------------------------------------------

  attach(viewer: Viewer): HelloMsg {
    this.viewers.set(viewer.session, viewer);

    let seat: Seat = "spectator";
    let note: string | undefined;
    if (this.playerSession === null || this.playerSession === viewer.session) {
      if (this.playerSession !== viewer.session) {
        // A fresh claim: hand over a body the pilot may have left mid-walk.
        this.engine.keys.clear();
        this.engine.touchMove = null;
        this.pilot.reset();
      }
      this.playerSession = viewer.session;
      seat = "player";
    } else {
      note = "Another viewer holds the crew seat — you are watching this shift.";
    }

    return {
      type: "hello",
      session: viewer.session,
      seat,
      matchId: this.matchId,
      state: this.buildState(true),
      history: this.history,
      ...(note ? { note } : {}),
    };
  }

  detach(session: string, token: string): void {
    const viewer = this.viewers.get(session);
    if (!viewer || viewer.token !== token) return;
    this.viewers.delete(session);
    if (this.playerSession === session) {
      // The seat frees the moment the tab goes away — the pilot takes the
      // body over, and the same session claims it straight back on rejoin.
      this.playerSession = null;
      this.engine.keys.clear();
      this.engine.touchMove = null;
    }
  }

  handleAction(session: string, msg: ClientMsg): void {
    const e = this.engine;
    switch (msg.type) {
      // View-scope controls: anyone may toggle the analyst overlay or ask for
      // the next shift after the verdict.
      case "analyst":
        e.analystView = msg.on;
        return;
      case "restart":
        if (e.phase === "ended") {
          this.nextPlayerIsImposter = msg.asImposter;
          this.startMatch();
        }
        return;
      default:
        break;
    }

    // Everything below drives the player's body — seat holder only.
    if (this.playerSession !== session) return;
    switch (msg.type) {
      case "key":
        e.setKey(msg.key, msg.down);
        return;
      case "touch":
        e.touchMove = msg.y === null ? null : { x: msg.x, y: msg.y };
        return;
      case "clear":
        e.keys.clear();
        e.touchMove = null;
        return;
      case "begin":
        e.begin(msg.spectate ?? false);
        return;
      case "interact":
        e.interact();
        return;
      case "kill":
        e.playerKill();
        return;
      case "report":
        e.report();
        return;
      case "sabotage":
        e.triggerSabotage();
        return;
      case "say":
        e.playerSay(msg.text);
        return;
      case "vote":
        e.playerVote(msg.key);
        return;
      case "advance":
        e.advanceMeeting();
        return;
      case "task":
        if (msg.done) e.completeActiveTask();
        else e.cancelActiveTask();
        return;
      case "spectate":
        e.enterSpectator();
        return;
    }
  }

  // -- broadcasting ----------------------------------------------------------

  /** One state frame for everyone, at the host's broadcast cadence. */
  maybeBroadcast(now: number = Date.now()): void {
    if (this.viewers.size === 0) return;
    // Mark the fog around the player exactly as the renderer would, so the
    // surveyed ratio in the HUD and the synced raster track the live match
    // even though nobody is drawing it.
    const e = this.engine;
    if (e.phase === "playing" && !e.spectator) e.visionPolygon();
    this.broadcastState(now);
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  get seatSession(): string | null {
    return this.playerSession;
  }

  get matchHistory(): MatchRecord[] {
    return this.history;
  }

  /** The ledger the next roster will read — exposed for the test. */
  get currentLedger(): LegacyLedger {
    return this.ledger;
  }

  private broadcastState(now: number = Date.now()): void {
    if (this.viewers.size === 0) return;
    this.broadcast(this.buildState(false, now));
  }

  private broadcast(msg: ServerMsg): void {
    if (this.viewers.size === 0) return;
    for (const viewer of [...this.viewers.values()]) viewer.send(msg);
  }

  buildState(full: boolean, now: number = Date.now()): StateMsg {
    const e = this.engine;
    if (full && e.phase === "playing" && !e.spectator) e.visionPolygon();

    const runs = encodeExplored(e.vis.explored);
    const json = JSON.stringify(runs);
    let explored: number[] | undefined;
    if (
      full ||
      this.lastExploredJson === null ||
      (json !== this.lastExploredJson && now - this.lastExploredSentAt >= 1500)
    ) {
      explored = runs;
      this.lastExploredJson = json;
      this.lastExploredSentAt = now;
    }

    return {
      type: "state",
      matchId: this.matchId,
      seq: ++this.seq,
      snapshot: e.snapshot(),
      render: {
        spectator: e.spectator,
        revealRoles: e.analystView,
        player: { ...e.player },
        playerAlive: e.playerActor.alive,
        crew: e.crewmates.map((c) => ({ ...c })),
        imp: e.imposters.map((i) => ({ ...i })),
        bodies: e.bodies.map((b) => ({ ...b })),
      },
      roster: rosterOf(e),
      ...(explored ? { explored } : {}),
    };
  }
}
