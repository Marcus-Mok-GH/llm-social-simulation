import { useState } from "react";
import { motion } from "framer-motion";
import { BookOpen, ChevronDown, History, Play, Quote, Rocket, Skull, Trophy } from "lucide-react";
import type { LegacyView, Snapshot } from "@/game/engine";
import { describeMatch, type MatchRecord } from "@/game/persistence";
import { buildRecap, type Recap, type RecapBeat } from "@/game/recap";
import { cn } from "@/lib/utils";

export interface RosterRow {
  key: string;
  name: string;
  color: string;
  isPlayer: boolean;
  /** The agent's own model, shown as a tooltip in the briefing. */
  model: string | null;
  /**
   * The role the engine dealt this seat. The briefing deliberately does not
   * show it (that would hand the player the answer); the broadcast layer uses
   * it for the audience-only reveal once you are spectating.
   */
  role: "crew" | "imposter";
}

interface BriefingProps {
  roster: RosterRow[];
  /** Cross-match grudges carried in from previous shifts, if any. */
  legacy?: LegacyView | null;
  /** Narrow layout: shorter copy in the pre-roll. */
  compact?: boolean;
  /** Start the shift as a viewer: full deck vision, AI cast only. */
  onWatch: () => void;
}

/**
 * The pre-shift card. There is no seat to take any more — the deck is cast,
 * the traitors are drawn at random, and the only way in is to watch.
 */
export function Briefing({
  roster,
  legacy = null,
  compact = false,
  onWatch,
}: BriefingProps) {
  // Only the AI cast is on the deck — your seat is the gallery.
  const cast = roster.filter((r) => !r.isPlayer);
  // Only the agents that actually walked in carrying something are worth
  // listing — the roster above already covers everyone else.
  const grudges = (legacy?.agents ?? []).filter((a) => a.grudges.length > 0);
  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center overflow-y-auto bg-void-950/92 px-3 py-4 sm:px-4 sm:py-6">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="my-auto w-full max-w-lg rounded-2xl border border-void-700 bg-void-900/90 p-5 text-center shadow-2xl sm:p-6"
      >
        <p className="text-[11px] tracking-[0.3em] text-slate-500">UMBRA STATION · DECK K7</p>
        <h2 className="mt-3 font-display text-3xl font-black text-white">
          The deck is <span className="text-signal">set</span>
        </h2>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-slate-400">
          {cast.length} AIs take the seats this shift — crewmates and hidden
          impostors, the traitors drawn at random from the cast before every
          match. You watch from the gallery with full deck vision, and the
          moment the shift starts every private thought is unlocked.
        </p>

        <ul className="mt-5 flex flex-wrap justify-center gap-2">
          {cast.map((r) => (
            <li
              key={r.key}
              title={r.model ?? undefined}
              className="flex items-center gap-2 rounded-full border border-void-700 bg-void-950/70 px-3 py-1 text-[11px] tracking-wider text-slate-400"
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: r.color }}
              />
              {r.name}
            </li>
          ))}
        </ul>

        {legacy && legacy.shifts > 0 && (
          <div className="mt-5 rounded-lg border border-void-700 bg-void-950/60 p-3 text-left">
            <p className="flex items-center gap-2 text-[10px] tracking-[0.2em] text-slate-500">
              <History className="h-3 w-3" aria-hidden />
              PRIOR SHIFTS · {legacy.shifts}
            </p>
            {grudges.length === 0 ? (
              <p className="mt-1.5 text-[10px] leading-snug text-slate-600">
                Nobody is holding a grudge yet. Vote out an innocent and that
                changes.
              </p>
            ) : (
              <ul className="mt-1.5 space-y-0.5">
                {grudges.map((agent) => (
                  <li key={agent.name} className="text-[10px] leading-snug text-slate-500">
                    <span className="text-slate-300">{agent.name}</span> walked in
                    distrusting{" "}
                    <span className="text-[#ff8a9c]">{agent.grudges.join(", ")}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-1.5 text-[9px] leading-snug text-slate-600">
              An agent that gets voted out blames everyone who voted for it — and
              opens the next shift already watching them.
            </p>
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={onWatch}
            className="inline-flex items-center gap-2 rounded-lg bg-signal px-6 py-3 text-sm font-bold tracking-wider text-void-950 transition hover:bg-signal/90"
          >
            <Play className="h-4 w-4" />
            SPECTATE THE SHIFT
          </button>
        </div>
        <p className="mt-3 text-[10px] leading-relaxed tracking-widest text-slate-600">
          {compact
            ? "YOU WATCH · THE AIs PLAY · TRAITORS DRAWN AT RANDOM"
            : "YOU SPECTATE · THE AIs PLAY · TRAITORS DRAWN AT RANDOM EACH SHIFT"}
        </p>
      </motion.div>
    </div>
  );
}

interface EndScreenProps {
  snap: Snapshot;
  history: MatchRecord[];
  /** Build the next shift: a fresh random draw of who the traitors are. */
  onRestart: () => void;
}

/** Colour for a recap beat's tag, by how the beat should feel. */
function toneClass(tone: RecapBeat["tone"]): string {
  switch (tone) {
    case "danger":
      return "border-[#ff4d6a]/50 bg-[#ff4d6a]/10 text-[#ff8a9c]";
    case "bad":
      return "border-amber-400/50 bg-amber-400/10 text-amber-300";
    case "good":
      return "border-signal/50 bg-signal/10 text-signal";
    default:
      return "border-void-700 bg-void-950/70 text-slate-400";
  }
}

/**
 * "The Story of the Shift": the finished match re-told as a short narrative,
 * collapsed by default so the stat grid still leads and the deck of the next
 * match is one tap away. The spotlight — the single beat that decided the round
 * — always shows; the timeline and the closing quote are behind the toggle.
 */
function RecapPanel({ recap }: { recap: Recap }) {
  const [open, setOpen] = useState(false);
  const { spotlight, quote, stats } = recap;

  return (
    <div className="mt-4 rounded-xl border border-void-700 bg-void-950/50 p-3 text-left">
      {spotlight && (
        <div className="rounded-lg border border-hazard/40 bg-hazard/5 px-3 py-2">
          <p className="text-[10px] tracking-[0.25em] text-hazard">{spotlight.label}</p>
          <p className="mt-0.5 text-[12px] leading-snug text-slate-200">{spotlight.text}</p>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-2.5 flex w-full items-center justify-between rounded-lg border border-void-700 bg-void-900/60 px-3 py-2 text-[10px] tracking-[0.2em] text-slate-400 transition hover:text-slate-200"
      >
        <span className="flex items-center gap-2">
          <BookOpen className="h-3 w-3" aria-hidden />
          STORY OF THE SHIFT
        </span>
        <span className="flex items-center gap-3 text-slate-500">
          <span className="hidden tabular-nums sm:inline">
            {stats.kills} KILLS · {stats.ejects} EJECTED
          </span>
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </span>
      </button>

      {open && (
        <div className="mt-2.5">
          <ol className="max-h-56 space-y-2 overflow-y-auto pr-1">
            {recap.beats.map((b, i) => (
              <li key={`${b.t}-${i}`} className="flex gap-2.5">
                <span className="w-9 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums text-slate-600">
                  {formatBeatClock(b.t)}
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      "inline-block rounded border px-1.5 py-px text-[9px] font-bold tracking-wider",
                      toneClass(b.tone),
                    )}
                  >
                    {b.headline}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-slate-300">
                    {b.text}
                  </span>
                </span>
              </li>
            ))}
          </ol>

          {quote && (
            <div className="mt-3 rounded-lg border border-void-700 bg-void-900/50 p-2.5">
              <p className="flex items-center gap-1.5 text-[9px] tracking-[0.2em] text-slate-500">
                <Quote className="h-2.5 w-2.5" aria-hidden />
                {quote.concealing ? "WHAT THE LIAR REALLY THOUGHT" : "WHAT THEY REALLY THOUGHT"}
              </p>
              <p className="mt-1 text-[11px] italic leading-snug text-slate-300">
                “{quote.text}”
              </p>
              <p className="mt-1 text-[9px] tracking-widest text-slate-500">
                — {quote.name}
                <span className={quote.role === "imposter" ? " text-[#ff8a9c]" : " text-signal"}>
                  {quote.role === "imposter" ? " · IMPOSTER" : " · CREW"}
                </span>
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatBeatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function EndScreen({ snap, history, onRestart }: EndScreenProps) {
  const crewWon = snap.winner === "crew";
  const last = history[0];
  const recap = last ? buildRecap(last) : null;

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center overflow-y-auto bg-void-950/94 px-3 py-6 sm:px-4 sm:py-8">
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        className="my-auto w-full max-w-xl rounded-2xl border border-void-700 bg-void-900/95 p-5 shadow-2xl sm:p-6"
      >
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-xl",
              crewWon ? "bg-signal/15 text-signal" : "bg-[#ff4d6a]/15 text-[#ff5a6e]",
            )}
          >
            {crewWon ? <Trophy className="h-6 w-6" /> : <Skull className="h-6 w-6" />}
          </span>
          <div>
            <p className="text-[11px] tracking-[0.25em] text-slate-500">SHIFT OVER</p>
            <h2 className="font-display text-2xl font-black text-white">
              {crewWon ? "Crew victory" : "Imposter victory"}
            </h2>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "TASK BAR", value: `${Math.round((snap.taskProgress || 0) * 100)}%` },
            { label: "MEETINGS", value: String(snap.meetings) },
            {
              label: "YOUR SEAT",
              value: snap.spectator
                ? "GALLERY"
                : snap.role === "crew"
                  ? "CREW"
                  : "IMPOSTER",
            },
            { label: "EJECTED", value: String(snap.ejects) },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-void-700 bg-void-950/60 px-3 py-2 text-center"
            >
              <p className="text-[10px] tracking-widest text-slate-600">{s.label}</p>
              <p className="font-mono text-lg text-slate-200">{s.value}</p>
            </div>
          ))}
        </div>

        {recap ? (
          <RecapPanel recap={recap} />
        ) : (
          last && (
            <p className="mt-4 text-center text-[11px] tracking-widest text-slate-500">
              {describeMatch(last)} · {last.ejects} EJECTED
            </p>
          )
        )}

        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={onRestart}
            className="inline-flex items-center gap-2 rounded-lg bg-signal px-5 py-2.5 text-sm font-bold tracking-wider text-void-950 transition hover:bg-signal/90"
          >
            <Rocket className="h-4 w-4" />
            NEXT SHIFT
          </button>
        </div>

        <p className="mt-4 text-center text-[10px] leading-relaxed text-slate-600">
          The next shift re-draws which AIs are the traitors. Match saved to
          local history with the full transcript and every agent's suspicion
          snapshot.
        </p>
      </motion.div>
    </div>
  );
}
