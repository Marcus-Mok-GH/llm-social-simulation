/**
 * The autopilot that plays the human's body while nobody is watching.
 *
 * A match must keep going when the tab closes — but the human's crewmate
 * cannot simply stand at spawn for ten minutes or the rejoin would be a corpse.
 * While no viewer holds the player seat, this pilot drives the exact same
 * public surface a human uses (`touchMove`, `setKey`, `interact`, `report`,
 * `playerKill`, `playerVote`), so it is bound by the same rules the engine
 * referees for everyone else.
 *
 * It is deliberately heuristic: walk the A* path with an analog vector, hold
 * `e` at a repair panel, press `E` at an assigned console and "play" the
 * minigame for a couple of seconds, report a body it reaches, vote its own
 * suspicion, and — as an impostor — close distance on the most isolated crew
 * member and press kill when the engine says the kill is legal.
 */

import {
  INTERACT_RANGE,
  KILL_RANGE,
  type GameEngine,
} from "../game/engine";
import type { Vec2 } from "../game/collision";
import { findPath } from "../game/navigation";
import { rankSuspects } from "../game/perception";

const WAYPOINT_EPS = 14;
const REPATH_S = 2.5;
const STUCK_S = 1.3;
/** Seconds of standing still before a goal is declared unreachable. */
const BLOCKED_FOR_S = 8;
/** How long the pilot "plays" a minigame before completing it. */
const MINIGAME_S = 2.6;

type SteerResult = "arrived" | "walking" | "blocked";

export class AfkPilot {
  private path: Vec2[] | null = null;
  private goalKey: string | null = null;
  private wp = 0;
  private repathAt = 0;
  private stuckAcc = 0;
  private lastX = 0;
  private lastY = 0;
  private forced = 0;
  private blockedUntil = new Map<string, number>();

  private taskSince = -1;
  private interactAt = 0;
  private arrivedSince = -1;
  private skippedTasks = new Set<string>();

  private seenMeeting = -1;
  private voteDelay = 0;

  private sabotageAt = 0;
  private targetKey: string | null = null;
  private targetAt = 0;
  private killAt = 0;
  private fakePoi: string | null = null;
  private fakeUntil = 0;

  /** Called when a human takes the seat back so a stale path is never reused. */
  reset(): void {
    this.path = null;
    this.goalKey = null;
    this.wp = 0;
    this.repathAt = 0;
    this.stuckAcc = 0;
    this.forced = 0;
    this.blockedUntil.clear();
    this.taskSince = -1;
    this.arrivedSince = -1;
    this.skippedTasks.clear();
    this.seenMeeting = -1;
    this.targetKey = null;
    this.targetAt = 0;
    this.fakePoi = null;
    this.fakeUntil = 0;
  }

  tick(engine: GameEngine, dt: number): void {
    const e = engine;
    const me = e.playerActor;

    if (e.phase !== "playing" || e.spectator || !me.alive) {
      e.touchMove = null;
      if (e.keys.has("e")) e.setKey("e", false);
      this.stuckAcc = 0;
      return;
    }

    // --- meetings: pause the body, still cast a vote ---------------------
    const meeting = e.meeting;
    if (meeting) {
      e.touchMove = null;
      if (meeting.startedAt !== this.seenMeeting) {
        this.seenMeeting = meeting.startedAt;
        this.voteDelay = 3 + Math.random() * 6;
      }
      if (
        meeting.stage === "voting" &&
        meeting.votes["player"] === undefined &&
        e.time >= meeting.startedAt + this.voteDelay
      ) {
        const top = rankSuspects(me.mind, 0)[0];
        e.playerVote(top?.key ?? null);
      }
      return;
    }
    this.seenMeeting = -1;

    // --- crew: hold the repair panel while a sabotage is live ------------
    const sab = e.sabotage;
    if (sab && me.role === "crew") {
      const poi = e.map.pointsOfInterest.find((p) => p.id === sab.fixPoiIds[0]);
      if (poi) {
        const res = this.steer(e, poi.x, poi.y, `fix:${poi.id}`, INTERACT_RANGE - 10, dt, REPATH_S);
        e.setKey("e", res === "arrived");
        return;
      }
    } else if (e.keys.has("e")) {
      e.setKey("e", false);
    }

    // --- crew: report a body it can actually reach -----------------------
    if (me.role === "crew" && e.bodies.length > 0) {
      const p = e.player;
      let best = e.bodies[0];
      let bestD = Infinity;
      for (const b of e.bodies) {
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      if (bestD <= 460) {
        const res = this.steer(e, best.x, best.y, `body:${best.id}`, INTERACT_RANGE - 8, dt, REPATH_S);
        if (res === "arrived") e.report();
        return;
      }
    }

    // --- impostor: run the traitor playbook ------------------------------
    if (me.role === "imposter") {
      if (!e.sabotage && e.sabotageCooldown <= 0 && e.time >= this.sabotageAt) {
        e.triggerSabotage();
        this.sabotageAt = e.time + 35;
      }

      if (me.killCooldown <= 0) {
        if (this.targetKey === null || e.time >= this.targetAt) {
          this.targetKey = this.pickKillTarget(e);
          this.targetAt = e.time + 7;
          this.path = null;
        }
        const target = this.targetKey
          ? e.actors.find((a) => a.key === this.targetKey && a.alive)
          : null;
        if (target) {
          const res = this.steer(
            e,
            target.entity.x,
            target.entity.y,
            `kill:${target.key}`,
            KILL_RANGE - 2,
            dt,
            1.2,
          );
          if (res === "arrived" && e.time >= this.killAt) {
            e.playerKill();
            this.killAt = e.time + 1;
            if (me.killCooldown > 0) {
              this.targetKey = null;
              this.path = null;
            }
          } else if (res === "blocked") {
            this.targetKey = null;
            this.path = null;
          }
          return;
        }
      }

      // Kill on cooldown: be seen working at a console (an alibi, like the
      // scripted impostors fake), then look again.
      if (!this.fakePoi || e.time >= this.fakeUntil) {
        const pois = e.map.pointsOfInterest.filter((p) => p.kind === "task");
        this.fakePoi = pois[Math.floor(Math.random() * pois.length)]?.id ?? null;
        this.fakeUntil = e.time + 7;
        this.path = null;
      }
      if (this.fakePoi) {
        const poi = e.map.pointsOfInterest.find((p) => p.id === this.fakePoi);
        if (poi) {
          this.steer(e, poi.x, poi.y, `fake:${poi.id}`, 40, dt, REPATH_S);
          return;
        }
      }
      e.touchMove = null;
      return;
    }

    // --- crew: work the assigned consoles --------------------------------
    const task = e.playerTasks.find((t) => !t.done && !this.skippedTasks.has(t.poiId));
    if (!task) {
      const spawn = e.map.pointsOfInterest.find((p) => p.kind === "spawn");
      if (spawn) this.steer(e, spawn.x, spawn.y, "idle", 60, dt, 4);
      else e.touchMove = null;
      return;
    }

    if (e.activeTask) {
      e.touchMove = null;
      if (this.taskSince < 0) this.taskSince = e.time;
      if (e.time - this.taskSince >= MINIGAME_S) {
        e.completeActiveTask();
        this.taskSince = -1;
        this.arrivedSince = -1;
      }
      return;
    }
    this.taskSince = -1;

    const poi = e.map.pointsOfInterest.find((p) => p.id === task.poiId);
    if (!poi) {
      this.skippedTasks.add(task.poiId);
      return;
    }

    const res = this.steer(e, poi.x, poi.y, `task:${task.poiId}`, INTERACT_RANGE - 10, dt, REPATH_S);
    if (res === "blocked") {
      this.skippedTasks.add(task.poiId);
      return;
    }
    if (res === "arrived") {
      if (this.arrivedSince < 0) this.arrivedSince = e.time;
      if (e.time >= this.interactAt) {
        e.interact();
        this.interactAt = e.time + 0.6;
      }
      // Standing on the console but the engine opens no task — the console is
      // not ours or not reachable; stop wedging on it.
      if (e.time - this.arrivedSince > 3.5) {
        this.skippedTasks.add(task.poiId);
        this.arrivedSince = -1;
      }
      return;
    }
    this.arrivedSince = -1;
  }

  /** The crew member furthest from any crowd — the kill the engine allows. */
  private pickKillTarget(engine: GameEngine): string | null {
    const me = engine.player;
    let best: string | null = null;
    let bestScore = Infinity;
    for (const a of engine.actors) {
      if (!a.alive || a.isPlayer || a.role !== "crew") continue;
      const d = Math.hypot(a.entity.x - me.x, a.entity.y - me.y);
      let crowd = 0;
      for (const other of engine.actors) {
        if (other === a || other.isPlayer || !other.alive) continue;
        if (Math.hypot(other.entity.x - a.entity.x, other.entity.y - a.entity.y) < 260) crowd++;
      }
      const score = d + crowd * 700;
      if (score < bestScore) {
        bestScore = score;
        best = a.key;
      }
    }
    return best;
  }

  /**
   * Walk a straight A* route to `(tx, ty)` by steering the human's analog
   * stick along the waypoints. Returns `arrived` when the goal is within
   * reach, `blocked` when no route holds (the caller moves on), `walking`
   * otherwise.
   */
  private steer(
    engine: GameEngine,
    tx: number,
    ty: number,
    goalKey: string,
    arrive: number,
    dt: number,
    repathIn: number,
  ): SteerResult {
    const p = engine.player;

    if (Math.hypot(tx - p.x, ty - p.y) <= arrive) {
      engine.touchMove = null;
      this.goalKey = null;
      this.path = null;
      this.stuckAcc = 0;
      this.forced = 0;
      return "arrived";
    }

    const blockedUntil = this.blockedUntil.get(goalKey);
    if (blockedUntil !== undefined && engine.time < blockedUntil) return "blocked";

    const needRepath =
      this.goalKey !== goalKey || this.path === null || engine.time >= this.repathAt;
    if (needRepath) {
      if (this.goalKey !== goalKey) {
        this.forced = 0;
        this.stuckAcc = 0;
      }
      this.goalKey = goalKey;
      this.repathAt = engine.time + repathIn;
      this.path = findPath(engine.grid, { x: p.x, y: p.y }, { x: tx, y: ty });
      this.wp = 0;
      if (!this.path || this.path.length === 0) {
        this.path = null;
        this.goalKey = null;
        engine.touchMove = null;
        this.blockedUntil.set(goalKey, engine.time + BLOCKED_FOR_S);
        return "blocked";
      }
    }

    // Stuck detection: no real movement for over a second means the route is
    // hugging a wall — re-path from the current spot, and give up after a few
    // tries so one wedged goal cannot park the pilot forever.
    const moved = Math.hypot(p.x - this.lastX, p.y - this.lastY);
    this.lastX = p.x;
    this.lastY = p.y;
    if (moved < 0.6) {
      this.stuckAcc += dt;
      if (this.stuckAcc > STUCK_S) {
        this.stuckAcc = 0;
        this.path = null;
        this.forced++;
        if (this.forced > 3) {
          this.forced = 0;
          this.goalKey = null;
          engine.touchMove = null;
          this.blockedUntil.set(goalKey, engine.time + BLOCKED_FOR_S);
          return "blocked";
        }
      }
      if (!this.path) return "walking";
    } else {
      this.stuckAcc = Math.max(0, this.stuckAcc - dt * 2);
      this.forced = 0;
    }

    const path = this.path!;
    while (
      this.wp < path.length - 1 &&
      Math.hypot(path[this.wp].x - p.x, path[this.wp].y - p.y) < WAYPOINT_EPS
    ) {
      this.wp++;
    }
    const target = path[this.wp];
    const dx = target.x - p.x;
    const dy = target.y - p.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) {
      engine.touchMove = null;
      return "walking";
    }
    engine.touchMove = { x: dx / len, y: dy / len };
    return "walking";
  }
}
