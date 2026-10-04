import { motion } from "framer-motion";
import { Rocket, Skull, Trophy } from "lucide-react";
import type { Snapshot } from "@/game/engine";
import { describeMatch, type MatchRecord } from "@/game/persistence";
import { cn } from "@/lib/utils";

export interface RosterRow {
  key: string;
  name: string;
  color: string;
  isPlayer: boolean;
}

interface BriefingProps {
  role: "crew" | "imposter";
  roster: RosterRow[];
  onStart: () => void;
}

/** Pre-match role reveal: who you are, who else is on the deck. */
export function Briefing({ role, roster, onStart }: BriefingProps) {
  const imposter = role === "imposter";
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-void-950/92 px-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="w-full max-w-lg rounded-2xl border border-void-700 bg-void-900/90 p-6 text-center shadow-2xl"
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

        <button
          type="button"
          onClick={onStart}
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-signal px-6 py-3 text-sm font-bold tracking-wider text-void-950 transition hover:bg-signal/90"
        >
          <Rocket className="h-4 w-4" />
          BEGIN SHIFT
        </button>
        <p className="mt-3 text-[10px] tracking-widest text-slate-600">
          WASD / ARROWS MOVE · E INTERACT · R REPORT
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
    <div className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto bg-void-950/94 px-4 py-8">
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-xl rounded-2xl border border-void-700 bg-void-900/95 p-6 shadow-2xl"
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
