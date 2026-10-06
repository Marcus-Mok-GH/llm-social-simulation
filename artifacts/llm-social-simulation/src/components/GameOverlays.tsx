import { motion } from "framer-motion";
import { Ghost, History, Rocket, Skull, Trophy } from "lucide-react";
import type { LegacyView, Snapshot } from "@/game/engine";
import { describeMatch, type MatchRecord } from "@/game/persistence";
import { cn } from "@/lib/utils";

export interface RosterRow {
  key: string;
  name: string;
  color: string;
  isPlayer: boolean;
  /** The agent's own model, shown as a tooltip in the briefing. */
  model: string | null;
}

interface BriefingProps {
  role: "crew" | "imposter";
  roster: RosterRow[];
  /** Cross-match grudges carried in from previous shifts, if any. */
  legacy?: LegacyView | null;
  /** Show touch control hints instead of the keyboard legend. */
  compact?: boolean;
  onStart: () => void;
  /** Start the match as a spectator: no avatar, full vision, AI only. */
  onSpectate: () => void;
}

/** Pre-match role reveal: who you are, who else is on the deck. */
export function Briefing({
  role,
  roster,
  legacy = null,
  compact = false,
  onStart,
  onSpectate,
}: BriefingProps) {
  const imposter = role === "imposter";
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
          You are{" "}
          <span className={imposter ? "text-[#ff5a6e]" : "text-signal"}>
            {imposter ? "an IMPOSTER" : "CREW"}
          </span>
        </h2>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-slate-400">
          {imposter
            ? "Blend in, fake tasks, and eliminate the crew without being seen. You have one ally on the deck — but the crew doesn't know who."
            : "Finish the station tasks and work out which of the AI crew are imposters. You only see what is in front of you."}
        </p>

        <ul className="mt-5 flex flex-wrap justify-center gap-2">
          {roster.map((r) => (
            <li
              key={r.key}
              title={r.model ?? undefined}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] tracking-wider",
                r.isPlayer
                  ? "border-signal/50 bg-signal/10 text-signal"
                  : "border-void-700 bg-void-950/70 text-slate-400",
              )}
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: r.color }}
              />
              {r.name}
              {r.isPlayer ? " (you)" : ""}
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
            onClick={onStart}
            className="inline-flex items-center gap-2 rounded-lg bg-signal px-6 py-3 text-sm font-bold tracking-wider text-void-950 transition hover:bg-signal/90"
          >
            <Rocket className="h-4 w-4" />
            BEGIN SHIFT
          </button>
          <button
            type="button"
            onClick={onSpectate}
            className="inline-flex items-center gap-2 rounded-lg border border-[#a78bfa]/50 bg-[#a78bfa]/10 px-5 py-3 text-sm font-bold tracking-wider text-[#c4b5fd] transition hover:bg-[#a78bfa]/20"
          >
            <Ghost className="h-4 w-4" />
            SPECTATE
          </button>
        </div>
        <p className="mt-3 text-[10px] tracking-widest text-slate-600">
          {compact
            ? "DRAG THE STICK TO MOVE · USE INTERACTS · TAP REPORT"
            : "WASD / ARROWS MOVE · E INTERACT · R REPORT"}
        </p>
      </motion.div>
    </div>
  );
}

interface EndScreenProps {
  snap: Snapshot;
  history: MatchRecord[];
  onRestart: (asImposter: boolean) => void;
}

export function EndScreen({ snap, history, onRestart }: EndScreenProps) {
  const crewWon = snap.winner === "crew";
  const last = history[0];

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
            { label: "TASKS", value: `${snap.tasks.filter((t) => t.done).length}/${snap.tasks.length || "—"}` },
            { label: "MEETINGS", value: String(snap.meetings) },
            { label: "YOUR ROLE", value: snap.role === "crew" ? "CREW" : "IMPOSTER" },
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

        {last && (
          <p className="mt-4 text-center text-[11px] tracking-widest text-slate-500">
            {describeMatch(last)} · {last.ejects} EJECTED
          </p>
        )}

        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={() => onRestart(false)}
            className="rounded-lg bg-signal px-5 py-2.5 text-sm font-bold tracking-wider text-void-950 transition hover:bg-signal/90"
          >
            PLAY AS CREW
          </button>
          <button
            type="button"
            onClick={() => onRestart(true)}
            className="rounded-lg border border-[#ff4d6a]/60 bg-[#ff4d6a]/10 px-5 py-2.5 text-sm font-bold tracking-wider text-[#ff8a9c] transition hover:bg-[#ff4d6a]/20"
          >
            PLAY AS IMPOSTER
          </button>
        </div>

        <p className="mt-4 text-center text-[10px] leading-relaxed text-slate-600">
          Match saved to local history with the full transcript and every agent's
          suspicion snapshot.
        </p>
      </motion.div>
    </div>
  );
}
