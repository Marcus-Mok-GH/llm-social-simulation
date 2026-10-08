/**
 * The broadcast layer — the shots the Turing Games edit cuts to.
 *
 * The engine already banks every beat of a match as structured events
 * (`events.ts`); this component turns those events into the on-screen grammar
 * of a produced show: the emergency-meeting slam, the ejection screen with the
 * role reveal, the victory card, the audience-only impostor reveal, the kill
 * sting, and a play-by-play ticker running along the deck.
 *
 * Two rules govern everything here:
 *
 *  1. **Every line comes from a real event.** Nothing is invented, parsed out
 *     of prose, or predicted — the ticker and the stings read the same
 *     append-only timeline the end-of-match recap is built from, so the show
 *     always matches what actually happened.
 *  2. **Nothing a spectator learns leaks to a player.** Kill details (who did
 *     it, where) and the impostor reveal are gated to spectators and finished
 *     matches — exactly the gate the confessional uses. Meeting, ejection,
 *     sabotage and verdict beats are public knowledge in the game itself, so
 *     they always show.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { TargetAndTransition } from "framer-motion";
import type { MatchEvent } from "@/game/events";
import type { Phase, Snapshot } from "@/game/engine";
import type { RosterRow } from "./GameOverlays";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Ticker copy — one function, pure, so the same event always calls the same
// play-by-play line.
// ---------------------------------------------------------------------------

/** The line for one timeline beat, or null when the beat is not on-air yet. */
function lineFor(e: MatchEvent, spoiler: boolean): string | null {
  switch (e.kind) {
    case "kill":
      // The crew is not allowed to know an unwitnessed kill happened — so
      // while you are playing, the director stays quiet about it too.
      if (!spoiler) return null;
      return `${e.killerName} eliminated ${e.victimName} in ${e.roomName}${
        e.witnessed ? " — SEEN" : " — UNSEEN"
      }`;
    case "sabotage":
      return e.sabotage === "meltdown"
        ? "SABOTAGE — REACTOR MELTDOWN"
        : "SABOTAGE — LIGHTS OUT";
    case "repair":
      return e.sabotage === "meltdown"
        ? "Reactor stabilised — the meltdown is over"
        : "Lights restored";
    case "meeting":
      return e.reason === "emergency"
        ? `${e.byName} called an emergency meeting`
        : `${e.byName} reported a body`;
    case "eject":
      return `${e.name} was ejected — ${
        e.role === "imposter" ? "an impostor" : "innocent"
      }`;
    case "end":
      return e.winner === "crew" ? "CREW VICTORY" : "IMPOSTER VICTORY";
    default:
      return null;
  }
}

/** Task-bar tiers, so the crew's progress gets announced as it happens. */
function taskTier(progress: number): number {
  if (progress >= 1) return 4;
  if (progress >= 0.75) return 3;
  if (progress >= 0.5) return 2;
  if (progress >= 0.25) return 1;
  return 0;
}

function taskLine(tier: number): string {
  switch (tier) {
    case 1:
      return "Station tasks at 25% — the crew is moving";
    case 2:
      return "Station tasks at 50% — halfway home";
    case 3:
      return "Station tasks at 75% — the impostors are running out of time";
    default:
      return "Station tasks complete";
  }
}

// ---------------------------------------------------------------------------
// Stings
// ---------------------------------------------------------------------------

type Sting =
  | { kind: "meeting"; title: string; sub: string }
  | { kind: "eject"; name: string | null; isImposter: boolean }
  | { kind: "victory"; winner: "crew" | "imposter" }
  | { kind: "reveal"; impostors: { key: string; name: string; color: string }[] }
  | {
      kind: "kill";
      killer: string;
      killerColor: string;
      victim: string;
      room: string;
      witnessed: boolean;
    };

interface BroadcastProps {
  snap: Snapshot;
  /** The full cast with roles — used for the audience-only reveal card. */
  roster: RosterRow[];
  /** Phone layout: the HUD owns the top of the screen, so no ticker. */
  compact?: boolean;
}

interface PrevSnap {
  meetingOpen: boolean;
  stage: string | null;
  phase: Phase;
  spectator: boolean;
  kills: number;
  taskTier: number;
}

export function Broadcast({ snap, roster, compact = false }: BroadcastProps) {
  const reduce = useReducedMotion();
  const [sting, setSting] = useState<Sting | null>(null);
  const [ticker, setTicker] = useState<{ id: number; text: string } | null>(
    null,
  );
  const stingSeq = useRef(0);
  const tickerSeq = useRef(0);
  const timeouts = useRef<number[]>([]);
  const prev = useRef<PrevSnap | null>(null);
  const announced = useRef<{ events: number; tier: number } | null>(null);

  // Every scheduled clear is tracked so an unmounting stage never leaves a
  // timer trying to setState on a dead component.
  const later = (fn: () => void, ms: number): void => {
    const id = window.setTimeout(fn, ms);
    timeouts.current.push(id);
  };

  useEffect(
    () => () => {
      for (const id of timeouts.current) window.clearTimeout(id);
      timeouts.current = [];
    },
    [],
  );

  const showSting = (next: Sting, ms: number): void => {
    const id = ++stingSeq.current;
    setSting(next);
    later(
      () => {
        if (stingSeq.current === id) setSting(null);
      },
      Math.max(800, ms - (reduce ? 400 : 0)),
    );
  };

  const pushTicker = (text: string): void => {
    const id = ++tickerSeq.current;
    setTicker({ id, text });
    later(
      () => {
        if (tickerSeq.current === id) setTicker(null);
      },
      6000,
    );
  };

  // --- transition detection ------------------------------------------------
  // The snapshot refreshes ten times a second; this effect watches it for the
  // edges that deserve a cut-away, firing at most one sting per refresh.
  useEffect(() => {
    const p = prev.current;
    prev.current = {
      meetingOpen: snap.meeting !== null,
      stage: snap.meeting?.stage ?? null,
      phase: snap.phase,
      spectator: snap.spectator,
      kills: snap.events.filter((e) => e.kind === "kill").length,
      taskTier: taskTier(snap.taskProgress),
    };
    // First paint (or a rejoin mid-shift): no sting for history you walked in
    // on — only for what happens while you are watching.
    if (!p) return;

    const spoiler = snap.spectator || snap.phase === "ended";
    const kills = snap.events.filter((e) => e.kind === "kill");

    if (kills.length > p.kills && spoiler && snap.phase !== "ended") {
      const k = kills[kills.length - 1];
      const row = roster.find((r) => r.key === k.killerKey);
      const victim = roster.find((r) => r.key === k.victimKey);
      showSting(
        {
          kind: "kill",
          killer: k.killerName,
          killerColor: row?.color ?? "#ff5a6e",
          victim: k.victimName,
          room: k.roomName,
          witnessed: k.witnessed,
        },
        2600,
      );
      return;
    }

    if (snap.phase === "ended" && p.phase !== "ended" && snap.winner) {
      showSting({ kind: "victory", winner: snap.winner }, 3000);
      return;
    }

    if (snap.meeting && !p.meetingOpen) {
      const lastMeeting = [...snap.events]
        .reverse()
        .find((e) => e.kind === "meeting");
      showSting(
        {
          kind: "meeting",
          title: snap.meeting.reason === "Emergency meeting" ? "EMERGENCY MEETING" : "BODY REPORTED",
          sub: lastMeeting
            ? lastMeeting.reason === "emergency"
              ? `${lastMeeting.byName} called it`
              : `${lastMeeting.byName} found the body`
            : "",
        },
        2600,
      );
      return;
    }

    if (snap.meeting?.stage === "tally" && p.stage !== "tally") {
      const e = snap.meeting.ejection;
      showSting(
        {
          kind: "eject",
          name: e?.name ?? null,
          isImposter: e?.isImposter ?? false,
        },
        3400,
      );
      return;
    }

    if (snap.spectator && !p.spectator && snap.phase === "playing") {
      const impostors = roster
        .filter((r) => r.role === "imposter")
        .map((r) => ({ key: r.key, name: r.name, color: r.color }));
      if (impostors.length > 0) {
        showSting({ kind: "reveal", impostors }, 4000);
        return;
      }
    }
  }, [snap, roster]);

  // --- the director's ticker ----------------------------------------------
  useEffect(() => {
    const spoiler = snap.spectator || snap.phase === "ended";
    const tier = taskTier(snap.taskProgress);

    if (!announced.current) {
      announced.current = { events: snap.events.length, tier };
      return;
    }

    let line: string | null = null;
    if (snap.events.length > announced.current.events) {
      // Walk only the new beats, keeping the last one that is on-air worthy —
      // a report landing in the same tick as its kill should read the report.
      const fresh = snap.events.slice(announced.current.events);
      for (const e of fresh) {
        const text = lineFor(e, spoiler);
        if (text) line = text;
      }
      announced.current = { events: snap.events.length, tier };
    }

    if (tier !== announced.current.tier) {
      // A restarted shift drops back to zero; re-anchor instead of announcing
      // "25%" backwards.
      if (tier < announced.current.tier || snap.phase !== "playing") {
        announced.current = { events: snap.events.length, tier };
      } else if (!line) {
        line = taskLine(tier);
        announced.current = { events: snap.events.length, tier };
      }
    }

    if (line) pushTicker(line);
  }, [snap]);

  /** Entrance that respects the user's reduced-motion setting: with reduce on,
   *  the element simply appears at its final state. */
  const animate = (
    from: TargetAndTransition,
    to: TargetAndTransition,
  ): { initial: TargetAndTransition | false; animate: TargetAndTransition } => ({
    initial: reduce ? false : from,
    animate: to,
  });

  return (
    <>
      {/* Play-by-play ticker: a chyron over the deck, never in the way.
          Phones keep the top of the screen for the HUD, so no ticker there. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 z-40 flex justify-center px-3",
          compact && "hidden",
        )}
        style={compact ? undefined : { top: "7.5rem" }}
      >
        <AnimatePresence>
          {ticker && (
            <motion.div
              key={ticker.id}
              {...animate(
                { opacity: 0, y: -8 },
                { opacity: 1, y: 0, transition: { duration: 0.25 } },
              )}
              exit={{ opacity: 0, transition: { duration: 0.4 } }}
              className="max-w-md rounded-full border border-void-700 bg-void-950/92 px-4 py-1.5 text-center text-[11px] tracking-wider text-slate-300 shadow-xl backdrop-blur-sm"
            >
              <span className="mr-2 text-[9px] font-bold tracking-[0.25em] text-hazard">
                LIVE
              </span>
              {ticker.text}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* The stings — full-stage cut-aways above every other overlay. */}
      <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center overflow-hidden">
        <AnimatePresence>
          {sting && (
            <motion.div
              key={`${sting.kind}-${stingSeq.current}`}
              {...animate(
                { opacity: 0 },
                { opacity: 1, transition: { duration: 0.18 } },
              )}
              exit={{ opacity: 0, transition: { duration: 0.35 } }}
              className="absolute inset-0 flex items-center justify-center bg-void-950/93 px-4"
            >
              {sting.kind === "meeting" && (
                <div className="text-center">
                  <motion.p
                    {...animate(
                      { opacity: 0, letterSpacing: "0.6em" },
                      {
                        opacity: 1,
                        letterSpacing: "0.3em",
                        transition: { duration: 0.35 },
                      },
                    )}
                    className="text-xs font-bold text-hazard"
                  >
                    ⚠ SHIP ALERT
                  </motion.p>
                  <motion.h2
                    {...animate(
                      { opacity: 0, scale: 1.35 },
                      {
                        opacity: 1,
                        scale: 1,
                        transition: { type: "spring", stiffness: 220, damping: 16 },
                      },
                    )}
                    className="mt-2 font-display text-4xl font-black tracking-tight text-white sm:text-6xl"
                  >
                    {sting.title}
                  </motion.h2>
                  {sting.sub && (
                    <p className="mt-3 text-sm text-slate-400">{sting.sub}</p>
                  )}
                </div>
              )}

              {sting.kind === "eject" && (
                <div className="text-center">
                  {sting.name ? (
                    <>
                      <motion.p
                        {...animate(
                          { opacity: 0, y: 24 },
                          { opacity: 1, y: 0, transition: { duration: 0.5 } },
                        )}
                        className="font-display text-5xl font-black text-white sm:text-7xl"
                      >
                        {sting.name}
                      </motion.p>
                      <motion.p
                        {...animate(
                          { opacity: 0 },
                          {
                            opacity: 1,
                            transition: { delay: 0.6, duration: 0.4 },
                          },
                        )}
                        className={cn(
                          "mt-4 text-lg font-bold tracking-[0.2em] sm:text-2xl",
                          sting.isImposter ? "text-signal" : "text-hazard",
                        )}
                      >
                        {sting.isImposter
                          ? "WAS AN IMPOSTOR"
                          : "WAS NOT AN IMPOSTOR"}
                      </motion.p>
                    </>
                  ) : (
                    <p className="font-display text-2xl font-black tracking-wide text-slate-300 sm:text-4xl">
                      NO ONE WAS EJECTED
                    </p>
                  )}
                  <p className="mt-5 text-[10px] tracking-[0.3em] text-slate-600">
                    EJECTED INTO THE VOID
                  </p>
                </div>
              )}

              {sting.kind === "victory" && (
                <div className="text-center">
                  <motion.h2
                    {...animate(
                      { opacity: 0, scale: 0.8 },
                      {
                        opacity: 1,
                        scale: 1,
                        transition: { type: "spring", stiffness: 200, damping: 15 },
                      },
                    )}
                    className={cn(
                      "font-display text-5xl font-black tracking-tight sm:text-7xl",
                      sting.winner === "crew" ? "text-signal" : "text-[#ff5a6e]",
                    )}
                  >
                    {sting.winner === "crew" ? "CREW VICTORY" : "IMPOSTER VICTORY"}
                  </motion.h2>
                  <p className="mt-3 text-xs tracking-[0.3em] text-slate-500">
                    SHIFT COMPLETE
                  </p>
                </div>
              )}

              {sting.kind === "reveal" && (
                <div className="w-full max-w-md text-center">
                  <p className="text-[11px] font-bold tracking-[0.35em] text-hazard">
                    THE ROOM DOESN'T KNOW THIS YET
                  </p>
                  <h2 className="mt-3 font-display text-3xl font-black text-white sm:text-4xl">
                    YOUR IMPOSTORS
                  </h2>
                  <ul className="mt-5 space-y-2">
                    {sting.impostors.map((imp) => (
                      <motion.li
                        key={imp.key}
                        {...animate(
                          { opacity: 0, x: -16 },
                          {
                            opacity: 1,
                            x: 0,
                            transition: { delay: 0.35, duration: 0.35 },
                          },
                        )}
                        className="flex items-center justify-center gap-3 rounded-xl border border-void-700 bg-void-900/80 px-4 py-3"
                      >
                        <span
                          className="h-4 w-4 rounded-full"
                          style={{ backgroundColor: imp.color }}
                        />
                        <span className="font-display text-lg font-bold text-slate-100">
                          {imp.name}
                        </span>
                      </motion.li>
                    ))}
                  </ul>
                  <p className="mt-4 text-[10px] leading-relaxed tracking-widest text-slate-600">
                    SPECTATOR VIEW · ROLE REVEAL IS OFF FOR PLAYERS
                  </p>
                </div>
              )}

              {sting.kind === "kill" && (
                <div className="text-center">
                  <p className="text-[11px] font-bold tracking-[0.4em] text-[#ff4d6a]">
                    ELIMINATION
                  </p>
                  <motion.p
                    {...animate(
                      { opacity: 0, scale: 1.2 },
                      {
                        opacity: 1,
                        scale: 1,
                        transition: { type: "spring", stiffness: 240, damping: 18 },
                      },
                    )}
                    className="mt-3 font-display text-3xl font-black sm:text-5xl"
                  >
                    <span style={{ color: sting.killerColor }}>{sting.killer}</span>
                    <span className="mx-3 text-[#ff4d6a]">✕</span>
                    <span className="text-slate-200">{sting.victim}</span>
                  </motion.p>
                  <p className="mt-3 text-xs tracking-[0.25em] text-slate-500">
                    {sting.room} · {sting.witnessed ? "WITNESSED" : "NO WITNESSES"}
                  </p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
