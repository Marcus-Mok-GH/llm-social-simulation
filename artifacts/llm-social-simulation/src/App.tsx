import { motion } from "framer-motion";
import { Activity, Cpu, Map as MapIcon, Radar, Rocket, ShieldAlert, Users } from "lucide-react";
import { MapCanvas } from "@/components/MapCanvas";
import { UMBRA_DECK_MAP } from "@/game/map";
import { MAP_LEGEND, POI_LEGEND_COLORS } from "@/game/render/renderMap";
import { cn } from "@/lib/utils";

const convexConfigured = Boolean(import.meta.env.VITE_CONVEX_URL);

const systems = [
  { label: "Vite", detail: "Build tool", ok: true },
  { label: "React + TS", detail: "UI runtime", ok: true },
  { label: "Tailwind", detail: "Styling", ok: true },
  {
    label: "Convex",
    detail: convexConfigured ? "Connected" : "Awaiting deployment",
    ok: convexConfigured,
  },
];

const roadmap = [
  { phase: "Phase 0", title: "Scaffold & tooling", status: "done" },
  { phase: "Phase 1", title: "Station map & renderer", status: "done" },
  { phase: "Phase 2", title: "Player movement & collision", status: "done" },
  { phase: "Phase 3", title: "AI crewmates & pathfinding", status: "done" },
  { phase: "Phase 4", title: "Imposter AI & vent travel", status: "active" },
  { phase: "Phase 5", title: "Vision fog, kills & sabotage", status: "queued" },
];

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

export default function App() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="starfield pointer-events-none absolute inset-0 opacity-70" />
      <div className="pointer-events-none absolute -left-40 top-1/3 h-80 w-80 rounded-full bg-signal/10 blur-3xl animate-pulseGlow" />

      <div className="relative mx-auto w-full max-w-6xl px-6 py-10">
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
                SOCIAL DEDUCTION SIM
              </p>
            </div>
          </div>
          <span className="hidden items-center gap-2 rounded-full border border-void-700 bg-void-900/60 px-3 py-1 text-[11px] tracking-widest text-slate-400 sm:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-hazard animate-pulseGlow" />
            PHASE 4 — IMPOSTER AI
          </span>
        </header>

        <main className="py-12">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="max-w-3xl"
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-signal/30 bg-signal/5 px-3 py-1 text-[11px] tracking-widest text-signal">
              <Rocket className="h-3.5 w-3.5" />
              PHASE 3 COMPLETE — PHASE 4 IN PROGRESS
            </span>

            <h1 className="mt-6 font-display text-4xl font-black leading-tight tracking-tight text-white sm:text-6xl">
              Trust no one
              <span className="block text-signal">aboard the station.</span>
            </h1>

            <p className="mt-5 max-w-xl text-sm leading-relaxed text-slate-400">
              A social-deduction game where you play as one crew member among
              AI-driven agents. Crewmates run tasks; hidden imposters lie, kill,
              and sabotage. Every decision is made by an LLM agent with its own
              perception and memory — not a scripted state machine.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-lg bg-signal px-5 py-2.5 text-sm font-semibold text-void-950 transition hover:bg-signal/90"
              >
                <Users className="h-4 w-4" />
                Enter the lobby
              </button>
              <span className="inline-flex items-center gap-2 rounded-lg border border-void-700 bg-void-900/60 px-5 py-2.5 text-sm text-slate-400">
                <Cpu className="h-4 w-4 text-hazard" />
                AI crewmates are live on the deck
              </span>
            </div>
          </motion.div>

          {/* Deck map */}
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="mt-16"
          >
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
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

            <MapCanvas />

            <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[11px] text-slate-400">
              {MAP_LEGEND.map((entry) => (
                <li key={entry.kind} className="flex items-center gap-2">
                  <LegendSwatch kind={entry.kind} />
                  <span className="tracking-wider">{entry.label}</span>
                </li>
              ))}
            </ul>
          </motion.section>

          <div className="mt-16 grid gap-6 md:grid-cols-2">
            <motion.section
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
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
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="rounded-xl border border-void-700 bg-void-900/50 p-5"
            >
              <div className="mb-4 flex items-center gap-2 text-xs tracking-widest text-slate-400">
                <ShieldAlert className="h-4 w-4 text-hazard" />
                MISSION ROADMAP
              </div>
              <ul className="space-y-3">
                {roadmap.map((r) => (
                  <li key={r.phase} className="flex items-center justify-between">
                    <div className="flex items-baseline gap-3">
                      <span className="font-display text-[10px] tracking-widest text-slate-500">
                        {r.phase}
                      </span>
                      <span className="text-sm text-slate-200">{r.title}</span>
                    </div>
                    <span
                      className={cn(
                        "text-[10px] tracking-wider",
                        r.status === "done" && "text-signal",
                        r.status === "active" && "text-hazard",
                        r.status === "queued" && "text-slate-600",
                      )}
                    >
                      {r.status.toUpperCase()}
                    </span>
                  </li>
                ))}
              </ul>
            </motion.section>
          </div>
        </main>

        <footer className="border-t border-void-800 pt-4 text-[11px] tracking-widest text-slate-600">
          UMBRA STATION · ORIGINAL IP · VITE + REACT + CONVEX
        </footer>
      </div>
    </div>
  );
}
