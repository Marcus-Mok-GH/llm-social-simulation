import { useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  BrainCircuit,
  Cpu,
  History,
  Map as MapIcon,
  Radar,
  ShieldAlert,
} from "lucide-react";
import { readLlmConfig } from "@/ai/llm";
import { MAP_LEGEND, POI_LEGEND_COLORS } from "@/game/render/renderMap";
import { UMBRA_DECK_MAP } from "@/game/map";
import { describeMatch, loadMatches, type MatchRecord } from "@/game/persistence";
import { GameStage } from "@/components/GameStage";
import { cn } from "@/lib/utils";

const llmConfigured = Boolean(readLlmConfig());

const systems = [
  { label: "Vite + React + TS", detail: "App shell", ok: true },
  { label: "Canvas 2D", detail: "Renderer + fog of war", ok: true },
  { label: "A* pathfinding", detail: "Agent navigation", ok: true },
  { label: "Berget AI", detail: llmConfigured ? "Model connected" : "No API key", ok: llmConfigured },
];

const roadmap = [
  { phase: "0", title: "Scaffold & tooling", status: "done" },
  { phase: "1", title: "Station map & renderer", status: "done" },
  { phase: "2", title: "Movement, collision & vision fog", status: "done" },
  { phase: "3", title: "Tasks, minigames, kills & sabotage", status: "done" },
  { phase: "4", title: "Meetings, dialogue, voting & ejections", status: "done" },
  { phase: "5", title: "Belief model + LLM decision loop", status: "done" },
  { phase: "6", title: "Match history & agent memory snapshots", status: "done" },
  { phase: "7", title: "Convex backend, auth & replays", status: "queued" },
] as const;

function LegendSwatch({ kind }: { kind: keyof typeof POI_LEGEND_COLORS }) {
  const color = POI_LEGEND_COLORS[kind];
  return (
    <span
      className="inline-block h-3 w-3 rotate-45 rounded-[2px]"
      style={{
        backgroundColor: kind === "spawn" ? "transparent" : color,
        border: kind === "spawn" ? `2px dashed ${color}` : "none",
      }}
    />
  );
}

function HistoryPanel({ matches }: { matches: MatchRecord[] }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.5 }}
      className="rounded-xl border border-void-700 bg-void-900/50 p-5"
    >
      <div className="mb-4 flex items-center gap-2 text-xs tracking-widest text-slate-400">
        <History className="h-4 w-4 text-signal" />
        MATCH HISTORY
      </div>
      {matches.length === 0 ? (
        <p className="text-xs leading-relaxed text-slate-500">
          No matches recorded yet. Finish a shift and the transcript, ejections and
          every agent's suspicion snapshot are saved here.
        </p>
      ) : (
        <ul className="space-y-3">
          {matches.slice(0, 6).map((m) => (
            <li key={m.id} className="border-b border-void-800 pb-3 last:border-0 last:pb-0">
              <div className="flex items-center justify-between gap-3">
                <span
                  className={cn(
                    "text-xs font-semibold",
                    m.winner === "crew" ? "text-signal" : "text-[#ff5a6e]",
                  )}
                >
                  {describeMatch(m)}
                </span>
                <span className="text-[10px] tracking-widest text-slate-600">
                  {m.playerRole === "crew" ? "AS CREW" : "AS IMPOSTER"}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {m.roster.map((r) => `${r.name}${r.role === "imposter" ? "*" : ""}`).join(" · ")}
                {m.llm.calls > 0 && (
                  <span className="ml-2 text-slate-600">
                    · {m.llm.calls} model calls / {m.llm.fallbacks} fallbacks
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </motion.section>
  );
}

export default function App() {
  const [matches, setMatches] = useState<MatchRecord[]>(() => loadMatches());

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="starfield pointer-events-none absolute inset-0 opacity-70" />
      <div className="pointer-events-none absolute -left-40 top-1/3 h-80 w-80 rounded-full bg-signal/10 blur-3xl animate-pulseGlow" />

      <div className="relative mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-signal/40 bg-signal/10">
              <Radar className="h-5 w-5 text-signal" />
            </div>
            <div className="leading-tight">
              <p className="font-display text-sm font-bold tracking-[0.25em] text-slate-100">
                UMBRA STATION
              </p>
              <p className="text-[11px] tracking-widest text-slate-500">
                LLM SOCIAL SIMULATION
              </p>
            </div>
          </div>
          <span className="hidden items-center gap-2 rounded-full border border-void-700 bg-void-900/60 px-3 py-1 text-[11px] tracking-widest text-slate-400 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-signal animate-pulseGlow" />
            {llmConfigured ? "BERGET AI ONLINE" : "HEURISTIC AGENTS"}
          </span>
        </header>

        <main className="py-6 sm:py-10">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="max-w-3xl"
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-signal/30 bg-signal/5 px-3 py-1 text-[11px] tracking-widest text-signal">
              <BrainCircuit className="h-3.5 w-3.5" />
              PLAYABLE — AGENTS REASON, REMEMBER AND LIE
            </span>

            <h1 className="mt-6 font-display text-4xl font-black leading-tight tracking-tight text-white sm:text-6xl">
              Trust no one
              <span className="block text-signal">aboard the station.</span>
            </h1>

            <p className="mt-5 max-w-xl text-sm leading-relaxed text-slate-400">
              A social-deduction game where you are one crew member among
              AI-driven agents. Every agent perceives only what it can actually
              see through the fog, remembers it, forms suspicion, and argues its
              case in meetings — with Berget AI doing the reasoning when a key is
              present and a belief-driven fallback when it isn't.
            </p>
          </motion.div>

          {/* The game */}
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="mt-10"
          >
            <div className="mb-4 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
              <div className="flex items-center gap-2">
                <MapIcon className="h-4 w-4 text-signal" />
                <h2 className="font-display text-lg font-bold tracking-widest text-slate-100">
                  {UMBRA_DECK_MAP.name.toUpperCase()}
                </h2>
              </div>
              <div className="flex gap-4 text-[11px] tracking-widest text-slate-500">
                <span>{UMBRA_DECK_MAP.rooms.length} ROOMS</span>
                <span>{UMBRA_DECK_MAP.corridors.length} CORRIDORS</span>
                <span>{UMBRA_DECK_MAP.pointsOfInterest.length} POINTS</span>
              </div>
            </div>

            <GameStage history={matches} onHistoryChange={setMatches} />

            <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[11px] text-slate-400">
              {MAP_LEGEND.map((entry) => (
                <li key={entry.kind} className="flex items-center gap-2">
                  <LegendSwatch kind={entry.kind} />
                  <span className="tracking-wider">{entry.label}</span>
                </li>
              ))}
            </ul>
          </motion.section>

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <motion.section
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="rounded-xl border border-void-700 bg-void-900/50 p-5"
            >
              <div className="mb-4 flex items-center gap-2 text-xs tracking-widest text-slate-400">
                <Activity className="h-4 w-4 text-signal" />
                SYSTEM STATUS
              </div>
              <ul className="space-y-3">
                {systems.map((s) => (
                  <li key={s.label} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-slate-200">{s.label}</p>
                      <p className="text-[11px] text-slate-500">{s.detail}</p>
                    </div>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px] tracking-wider",
                        s.ok ? "bg-signal/10 text-signal" : "bg-hazard/10 text-hazard",
                      )}
                    >
                      {s.ok ? "ONLINE" : "PENDING"}
                    </span>
                  </li>
                ))}
              </ul>
            </motion.section>

            <motion.section
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="rounded-xl border border-void-700 bg-void-900/50 p-5"
            >
              <div className="mb-4 flex items-center gap-2 text-xs tracking-widest text-slate-400">
                <ShieldAlert className="h-4 w-4 text-hazard" />
                MISSION ROADMAP
              </div>
              <ul className="space-y-3">
                {roadmap.map((r) => (
                  <li key={r.phase} className="flex items-center justify-between gap-3">
                    <div className="flex items-baseline gap-3">
                      <span className="font-display text-[10px] tracking-widest text-slate-500">
                        PHASE {r.phase}
                      </span>
                      <span className="text-sm text-slate-200">{r.title}</span>
                    </div>
                    <span
                      className={cn(
                        "text-[10px] tracking-wider",
                        r.status === "done" && "text-signal",
                        r.status === "queued" && "text-slate-600",
                      )}
                    >
                      {r.status.toUpperCase()}
                    </span>
                  </li>
                ))}
              </ul>
            </motion.section>

            <HistoryPanel matches={matches} />

            <motion.section
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="rounded-xl border border-void-700 bg-void-900/50 p-5"
            >
              <div className="mb-4 flex items-center gap-2 text-xs tracking-widest text-slate-400">
                <Cpu className="h-4 w-4 text-hazard" />
                HOW THE AGENTS THINK
              </div>
              <ol className="space-y-2.5 text-xs leading-relaxed text-slate-400">
                <li>
                  <span className="text-signal">1 · Perception</span> — line of
                  sight over the walkable geometry; no agent cheats through walls.
                </li>
                <li>
                  <span className="text-signal">2 · Memory</span> — sightings,
                  bodies and vents land in a capped per-agent memory with a
                  suspicion vector that decays over time.
                </li>
                <li>
                  <span className="text-signal">3 · Decision</span> — a periodic
                  model call returns one validated JSON intent; anything invalid
                  falls back to the scripted heuristic.
                </li>
                <li>
                  <span className="text-signal">4 · Debate</span> — meeting lines
                  come from the same memory the model reads, so agents accuse
                  from evidence rather than from a dialogue table.
                </li>
                <li>
                  <span className="text-signal">5 · Vote</span> — always computed
                  from suspicion scores, never from the model, so you can audit
                  it in the analyst panel.
                </li>
              </ol>
            </motion.section>
          </div>
        </main>

        <footer className="border-t border-void-800 pt-4 text-[11px] tracking-widest text-slate-600">
          UMBRA STATION · ORIGINAL IP · VITE + REACT + BERGET AI
        </footer>
      </div>
    </div>
  );
}
