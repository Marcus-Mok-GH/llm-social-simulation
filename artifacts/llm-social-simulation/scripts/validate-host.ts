/**
 * Station host integration test.
 *
 * Proves the two promises of the autonomous host:
 *
 *  1. **The match keeps going while nobody is watching** — the engine ticks
 *     with zero viewers attached, and a viewer that reconnects with the same
 *     session id gets its own crew seat back on the *same* shift, at a later
 *     match time than when it left.
 *  2. **The agents learn between matches** — finished shifts fold into the
 *     cross-match ledger and shared history on disk, and a brand-new host
 *     process reading the same directory starts with that learning intact.
 *
 * It boots the real HTTP station (Vite middleware included) on an ephemeral
 * port, talks SSE/POST to it exactly like the browser does, then runs whole
 * matches headlessly through `MatchHost.pump`.
 *
 * Run: bun scripts/validate-host.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStation } from "../src/host/main";
import { MatchHost } from "../src/host/matchHost";
import { createFileStore } from "../src/host/store";
import type { ServerMsg } from "../src/host/protocol";

let bad = 0;
const check = (label: string, ok: boolean): void => {
  if (!ok) bad++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
};

interface MatchView {
  matchId: string;
  seat: string;
  state: {
    snapshot: { phase: string; time: number };
    render: { player: { x: number; y: number }; revealRoles: boolean };
    explored?: number[];
  };
  history: unknown[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Minimal SSE reader over fetch — the browser's EventSource, in test form. */
class SseReader {
  private events: { type: string; data: Record<string, unknown> }[] = [];
  private waiters: ((ev: { type: string; data: Record<string, unknown> }) => void)[] = [];
  private controller = new AbortController();
  private closed = false;

  async open(url: string): Promise<void> {
    const res = await fetch(url, { signal: this.controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE open failed: ${res.status}`);
    void this.pump(res.body);
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut = buf.indexOf("\n\n");
        while (cut >= 0) {
          const chunk = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          let type = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) type = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (data) this.push({ type, data: JSON.parse(data) });
          cut = buf.indexOf("\n\n");
        }
      }
    } catch {
      // aborted — expected
    }
  }

  private push(ev: { type: string; data: Record<string, unknown> }): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(ev);
      return;
    }
    this.events.push(ev);
    // Keep only the newest frames so a long headless run cannot grow memory.
    while (this.events.length > 8) this.events.shift();
  }

  next(timeoutMs = 5000): Promise<{ type: string; data: Record<string, unknown> }> {
    const queued = this.events.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for SSE event")), timeoutMs);
      this.waiters.push((ev) => {
        clearTimeout(timer);
        resolve(ev);
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
  }
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "umbra-host-"));
  const store = createFileStore(dataDir);

  const station = await startStation({
    port: 0,
    store,
    host: { autoBeginMs: 60_000, intermissionMs: 1200, broadcastMs: 50 },
  });
  const base = `http://127.0.0.1:${station.port}`;
  const post = (session: string, msg: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}/__umbra/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, msg }),
    });
  const match = (): Promise<MatchView> =>
    fetch(`${base}/__umbra/match?session=tab-a`).then((r) => r.json() as Promise<MatchView>);

  const readers: SseReader[] = [];
  try {
    // --- boot ------------------------------------------------------------
    const health = await fetch(`${base}/__umbra/health`);
    check("the station answers on /__umbra/health", health.status === 200);

    // --- attach: the first viewer claims the crew seat --------------------
    const sseA = new SseReader();
    readers.push(sseA);
    await sseA.open(`${base}/__umbra/events?session=tab-a`);
    const hello1 = (await sseA.next()) as {
      type: string;
      data: {
        seat: string;
        matchId: string;
        state: { snapshot: { phase: string }; explored?: number[] };
      };
    };
    check("SSE attach answers with a hello", hello1.type === "hello");
    check("the first viewer claims the player seat", hello1.data.seat === "player");
    check("hello carries the fog's explored raster", Array.isArray(hello1.data.state.explored));
    const firstMatchId = hello1.data.matchId;

    // --- input round-trip --------------------------------------------------
    await post("tab-a", { type: "begin" });
    await sleep(120);
    const started = await match();
    check("POST action begins the shift on the server", started.state.snapshot.phase === "playing");

    await post("tab-a", { type: "analyst", on: true });
    await sleep(120);
    const analyst = await match();
    check("viewer actions reach the engine", analyst.state.render.revealRoles === true);
    await post("tab-a", { type: "analyst", on: false });

    const x0 = started.state.render.player.x;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      await post("tab-a", { type: "touch", x: dx, y: dy });
      await sleep(260);
      const now = await match();
      if (Math.abs(now.state.render.player.x - x0) > 3) break;
    }
    const moved = await match();
    check(
      "movement input moves the player's body",
      Math.abs(moved.state.render.player.x - x0) > 3,
    );
    await post("tab-a", { type: "touch", x: 0, y: null });
    await sleep(80);

    // --- close the tab: the match keeps running ----------------------------
    sseA.close();
    await sleep(150);
    check("closing the tab releases the crew seat", station.host.seatSession === null);

    const t1 = (await match()).state.snapshot.time;
    await sleep(500);
    const t2 = (await match()).state.snapshot.time;
    check("the shift keeps ticking with zero viewers", t2 > t1);

    // --- rejoin: same session, same shift, seat back -----------------------
    const sseA2 = new SseReader();
    readers.push(sseA2);
    await sseA2.open(`${base}/__umbra/events?session=tab-a`);
    const hello2 = (await sseA2.next()) as {
      type: string;
      data: { seat: string; matchId: string; state: { snapshot: { time: number } } };
    };
    check("rejoining answers with a hello", hello2.type === "hello");
    check("rejoin gets the crew seat back", hello2.data.seat === "player");
    check("rejoin lands on the same shift", hello2.data.matchId === firstMatchId);
    check(
      "rejoin lands at a later point in the same shift",
      hello2.data.state.snapshot.time >= t2 - 0.01,
    );

    // A second browser (different session) only watches.
    const sseB = new SseReader();
    readers.push(sseB);
    await sseB.open(`${base}/__umbra/events?session=tab-b`);
    const helloB = (await sseB.next()) as { type: string; data: { seat: string } };
    check("a second viewer watches from the gallery", helloB.data.seat === "spectator");

    // --- run whole matches headlessly -------------------------------------
    const runToEnd = (label: string): void => {
      const host = station.host;
      let ticks = 0;
      while (host.engine.phase !== "ended" && ticks < 300_000) {
        host.pump(1 / 60, Date.now());
        ticks++;
      }
      check(label, host.engine.phase === "ended");
    };

    runToEnd("a hosted match runs to a verdict without a client");
    check("the finished shift is written to the shared history", store.loadHistory().length === 1);
    check("the finished shift folds into the ledger", store.loadLedger().shifts === 1);

    // The end screen's restart: next shift, human playing the impostor.
    // Before that, note this shift's traitors — the next draw must avoid them.
    const prevTraitors = station.host.engine.actors
      .filter((a) => !a.isPlayer && a.role === "imposter")
      .map((a) => a.cfg?.model)
      .filter((m): m is string => Boolean(m));
    await post("tab-a", { type: "restart", asImposter: true });
    await sleep(150);
    const second = await match();
    check("restart builds the next shift", second.matchId !== firstMatchId);
    check(
      "restart honours the requested role",
      station.host.engine.playerActor.role === "imposter",
    );
    const nextTraitors = station.host.engine.actors
      .filter((a) => !a.isPlayer && a.role === "imposter")
      .map((a) => a.cfg?.model)
      .filter((m): m is string => Boolean(m));
    check(
      "the next shift re-draws its traitors — never the pair that just played",
      // With no model key there are no models to compare; the draw itself is
      // covered headlessly in validate-imposters.
      prevTraitors.length === 0 ||
        (nextTraitors.length > 0 &&
          nextTraitors.every((m) => !prevTraitors.includes(m))),
    );
    await post("tab-a", { type: "begin" });
    await sleep(80);
    const secondMatchId = station.host.matchId;

    runToEnd("the second hosted match also runs to a verdict");
    check("both shifts are in the shared history", store.loadHistory().length === 2);
    check("both shifts folded into the ledger", store.loadLedger().shifts === 2);

    // --- intermission: the host chains the next shift by itself ------------
    await sleep(1500);
    const third = await match();
    check("the host starts the next shift on its own", third.matchId !== secondMatchId);
    check("the chained shift opens in briefing", third.state.snapshot.phase === "briefing");

    // --- a fresh process reads the learning back ---------------------------
    const reborn = new MatchHost(createFileStore(dataDir));
    check(
      "a new host process starts with the learned ledger",
      reborn.currentLedger.shifts === 2,
    );
    check(
      "a new host process starts with the shared history",
      reborn.matchHistory.length === 2,
    );
    // The shipped path: nobody clicks anything, the auto-begin fires, and the
    // shift opens in spectator mode — the gallery never takes a seat.
    reborn.pump(1 / 60, Date.now() + 60_000);
    check(
      "an unattended shift begins in spectator mode",
      reborn.engine.spectator === true,
    );
    reborn.engine.onMatchEnd = null;
  } finally {
    for (const r of readers) r.close();
    await station.close();
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(bad > 0 ? "\nStation host checks failed" : "\nStation host checks passed ✓");
  process.exit(bad > 0 ? 1 : 0);
}

const watchdog = setTimeout(() => {
  console.error("validate-host timed out");
  process.exit(1);
}, 120_000);
watchdog.unref?.();

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
