/**
 * The browser side of the autonomous match: a `GameLink` that talks to the
 * station host instead of running an engine in the page.
 *
 * State arrives on an SSE stream (`hello` on attach, then `state` frames) and
 * is rendered with one frame of interpolation, so a 10 Hz broadcast still
 * draws smooth movement. Input goes back as small POSTs. Because
 * `EventSource` reconnects on its own, a closed tab is exactly that — a
 * paused viewer: the host keeps ticking (with the AFK pilot flying the human
 * body), and reopening the tab lands on `hello` with the live match.
 *
 * If no host answers within a few seconds (a static build, say), the caller
 * falls back to `LocalGameLink` and the game still plays, just without the
 * cross-tab persistence.
 */

import type {
  ActorRow,
  DrawScene,
  GameLink,
  GameLinkHandlers,
  LinkStatus,
  Seat,
} from "./link";
import type { MoveInput } from "./player";
import type { Snapshot } from "./engine";
import { UMBRA_DECK_MAP } from "./map";
import { buildVisibilityGrid, castVision, type VisibilityGrid } from "./vision";
import type { MatchRecord } from "./persistence";
import {
  mergeExplored,
  type ClientMsg,
  type HelloMsg,
  type StateMsg,
} from "../host/protocol";

const API_BASE = (() => {
  const base = import.meta.env?.BASE_URL ?? "/";
  return base.endsWith("/") ? base : `${base}/`;
})();

const SESSION_KEY = "umbra.session.v1";
/** One broadcast of interpolation latency — also the smoothing window. */
const FRAME_MS = 100;
const TOUCH_MS = 50;

function sessionId(): string {
  try {
    let s = window.localStorage.getItem(SESSION_KEY);
    if (!s) {
      s =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      window.localStorage.setItem(SESSION_KEY, s);
    }
    return s.slice(0, 80);
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

const EMPTY_SCENE: DrawScene = {
  camera: null,
  player: null,
  playerAlive: true,
  crewmates: [],
  imposters: [],
  bodies: [],
  fog: null,
  revealRoles: false,
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class RemoteGameLink implements GameLink {
  readonly mode = "remote" as const;
  status: LinkStatus = "connecting";
  seat: Seat = "player";
  handlers: GameLinkHandlers = {};
  /** Called on every status transition so the stage can show the uplink. */
  onStatus: ((status: LinkStatus) => void) | null = null;

  readonly session: string;

  private es: EventSource | null = null;
  private disposed = false;
  private watchdog: number | null = null;
  private retry: number | null = null;

  private latest: StateMsg | null = null;
  private prev: StateMsg | null = null;
  private arrivedAt = 0;
  private span = FRAME_MS;

  /** The fog memory this viewer carries between tabs. */
  private grid: VisibilityGrid;

  private touch: MoveInput | null = null;
  private touchSentAt = 0;
  private touchTimer: number | null = null;

  constructor() {
    this.session = sessionId();
    this.grid = buildVisibilityGrid(UMBRA_DECK_MAP);
  }

  // -- connection -----------------------------------------------------------

  connect(): void {
    if (this.disposed) return;
    this.clearTimers();
    this.setStatus("connecting");
    this.es?.close();

    const es = new EventSource(
      `${API_BASE}__umbra/events?session=${encodeURIComponent(this.session)}`,
    );
    this.es = es;

    this.watchdog = window.setTimeout(() => {
      if (this.status === "connecting") {
        es.close();
        this.setStatus("offline");
        this.scheduleRetry();
      }
    }, 5000);

    es.addEventListener("hello", (ev) => {
      const msg = JSON.parse((ev as MessageEvent).data) as HelloMsg;
      this.seat = msg.seat;
      this.applyState(msg.state);
      this.setStatus("live");
      this.handlers.onHistory?.(msg.history);
    });
    es.addEventListener("state", (ev) => {
      this.applyState(JSON.parse((ev as MessageEvent).data) as StateMsg);
    });
    es.addEventListener("record", (ev) => {
      const msg = JSON.parse((ev as MessageEvent).data) as { history: MatchRecord[] };
      this.handlers.onHistory?.(msg.history);
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED && !this.disposed) {
        this.setStatus("offline");
        this.scheduleRetry();
      } else if (es.readyState === EventSource.CONNECTING) {
        // The browser is retrying on its own; reflect that honestly.
        this.setStatus("connecting");
      }
    };
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retry !== null) return;
    this.retry = window.setTimeout(() => {
      this.retry = null;
      this.connect();
    }, 2000);
  }

  private clearTimers(): void {
    if (this.watchdog !== null) {
      window.clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private setStatus(status: LinkStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatus?.(status);
  }

  private applyState(state: StateMsg): void {
    const changed = this.latest !== null && this.latest.matchId !== state.matchId;
    if (changed) {
      // A new shift: the surveyed fog belongs to the old one.
      this.prev = null;
      this.grid.explored.fill(0);
    }
    this.prev = this.latest;
    this.latest = state;
    this.arrivedAt =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (this.prev) {
      const raw = this.arrivedAt - (this.prevArrivedAt || this.arrivedAt - FRAME_MS);
      this.span = Math.min(400, Math.max(40, raw));
    }
    this.prevArrivedAt = this.arrivedAt;
    if (state.explored) mergeExplored(this.grid.explored, state.explored);
  }

  private prevArrivedAt = 0;

  private post(msg: ClientMsg): void {
    if (this.disposed) return;
    void fetch(`${API_BASE}__umbra/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: this.session, msg }),
    }).catch(() => {
      // A dropped action is a dropped frame of input, never an error screen.
    });
  }

  // -- GameLink -------------------------------------------------------------

  snapshot(): Snapshot {
    if (!this.latest) throw new Error("remote link has no state yet");
    return this.latest.snapshot;
  }

  roster(): ActorRow[] {
    return this.latest?.roster ?? [];
  }

  frame(nowMs: number): DrawScene {
    const s = this.latest;
    if (!s) return EMPTY_SCENE;

    // Interpolate prev → latest over the window *after* the latest arrived:
    // one frame of latency, but 10 Hz broadcasts still draw smoothly.
    let alpha = 1;
    if (this.prev && this.span > 0) {
      alpha = Math.min(1, Math.max(0, (nowMs - this.arrivedAt + this.span) / this.span));
    }

    const prev = this.prev && this.prev.matchId === s.matchId ? this.prev : null;
    const pos = <T extends { x: number; y: number }>(curr: T, old: T | undefined): T => {
      if (!old) return curr;
      return { ...curr, x: lerp(old.x, curr.x, alpha), y: lerp(old.y, curr.y, alpha) };
    };

    const player = pos(s.render.player, prev?.render.player);
    const crew = s.render.crew.map((c, i) => pos(c, prev?.render.crew[i]));
    const imp = s.render.imp.map((a, i) => pos(a, prev?.render.imp[i]));

    const fogged = s.snapshot.phase === "playing" && !s.render.spectator;
    return {
      camera: s.render.spectator ? null : { x: player.x, y: player.y },
      player: s.render.spectator ? null : player,
      playerAlive: s.render.playerAlive,
      crewmates: crew,
      imposters: imp,
      bodies: s.render.bodies,
      fog: fogged
        ? {
            polygon: castVision(this.grid, player.x, player.y, s.snapshot.visionRange),
            grid: this.grid,
          }
        : null,
      revealRoles: s.render.revealRoles,
    };
  }

  get touchMove(): MoveInput | null {
    return this.touch;
  }
  set touchMove(v: MoveInput | null) {
    this.touch = v;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const send = (): void => {
      this.touchSentAt =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      this.touchTimer = null;
      const t = this.touch;
      this.post({ type: "touch", x: t ? t.x : 0, y: t ? t.y : null });
    };
    if (now - this.touchSentAt >= TOUCH_MS) {
      send();
    } else if (this.touchTimer === null) {
      this.touchTimer = window.setTimeout(send, TOUCH_MS);
    }
  }

  setKey(key: string, down: boolean): void {
    this.post({ type: "key", key, down });
  }

  clearKeys(): void {
    this.post({ type: "clear" });
    this.touch = null;
  }

  begin(spectate = false): void {
    this.post({ type: "begin", spectate });
  }
  interact(): void {
    this.post({ type: "interact" });
  }
  kill(): void {
    this.post({ type: "kill" });
  }
  report(): void {
    this.post({ type: "report" });
  }
  sabotage(): void {
    this.post({ type: "sabotage" });
  }
  say(text: string): void {
    this.post({ type: "say", text });
  }
  vote(targetKey: string | null): void {
    this.post({ type: "vote", key: targetKey });
  }
  advanceMeeting(): void {
    this.post({ type: "advance" });
  }
  completeTask(): void {
    this.post({ type: "task", done: true });
  }
  failTask(): void {
    this.post({ type: "task", done: false });
  }
  enterSpectator(): void {
    this.post({ type: "spectate" });
  }

  get analyst(): boolean {
    return this.latest?.render.revealRoles ?? false;
  }
  set analyst(on: boolean) {
    this.post({ type: "analyst", on });
  }

  restart(): void {
    // The gallery never plays, so the next shift is cast for the AIs alone:
    // the host re-draws which of them are the traitors.
    this.post({ type: "restart", asImposter: false });
  }

  get taskOpen(): boolean {
    return this.latest?.snapshot.activeTask != null;
  }
  get meetingOpen(): boolean {
    return this.latest?.snapshot.meeting != null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimers();
    if (this.retry !== null) {
      window.clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.touchTimer !== null) {
      window.clearTimeout(this.touchTimer);
      this.touchTimer = null;
    }
    this.es?.close();
    this.es = null;
  }
}
