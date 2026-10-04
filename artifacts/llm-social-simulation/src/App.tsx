import { useState } from "react";
import { readProviders } from "@/ai/llm";
import { MAP_LEGEND, POI_LEGEND_COLORS } from "@/game/render/renderMap";
import { UMBRA_DECK_MAP } from "@/game/map";
import { loadMatches, type MatchRecord } from "@/game/persistence";
import { GameStage } from "@/components/GameStage";
import { cn } from "@/lib/utils";

/** The provider every AI agent runs on, chosen from the environment. */
const provider = readProviders()[0] ?? null;

function LegendSwatch({ kind }: { kind: keyof typeof POI_LEGEND_COLORS }) {
  const color = POI_LEGEND_COLORS[kind];
  return (
    <span
      className="inline-block h-2.5 w-2.5 rotate-45 rounded-[2px]"
      style={{
        backgroundColor: kind === "spawn" ? "transparent" : color,
        border: kind === "spawn" ? `1.5px dashed ${color}` : "none",
      }}
    />
  );
}

function ProviderStatus() {
  return (
    <span className="flex items-center gap-2 text-[11px] tracking-widest text-slate-500">
      <span
        className={cn("h-1.5 w-1.5 rounded-full", provider ? "bg-signal" : "bg-slate-600")}
      />
      {provider
        ? `${provider.provider.toUpperCase()} · ${provider.models.length} MODELS`
        : "HEURISTIC AGENTS"}
    </span>
  );
}

/**
 * The shell is deliberately thin: a wordmark, one line about the simulation,
 * and the deck. Everything else lives where it is needed (HUD, overlays) so
 * the map keeps the screen.
 */
export default function App() {
  const [matches, setMatches] = useState<MatchRecord[]>(() => loadMatches());

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-void-800 pb-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-base font-bold tracking-[0.3em] text-slate-100">
            UMBRA STATION
          </h1>
          <span className="text-[11px] tracking-widest text-slate-600">
            LLM SOCIAL SIMULATION
          </span>
        </div>
        <ProviderStatus />
      </header>

      <main className="py-8">
        <h2 className="font-display text-2xl font-black leading-tight tracking-tight text-white sm:text-3xl">
          Trust no one aboard the station.
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-slate-400">
          One crew member among AI agents that see only what the fog allows,
          remember it, and argue about it — each running on a different model.
        </p>

        <section className="mt-6">
          <GameStage history={matches} onHistoryChange={setMatches} />

          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[11px] text-slate-500">
            {MAP_LEGEND.map((entry) => (
              <li key={entry.kind} className="flex items-center gap-2">
                <LegendSwatch kind={entry.kind} />
                {entry.label}
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-void-800 pt-4 text-[10px] tracking-widest text-slate-600">
        <span>
          {UMBRA_DECK_MAP.rooms.length} ROOMS ·{" "}
          {UMBRA_DECK_MAP.pointsOfInterest.length} POINTS
        </span>
        <span>
          {provider ? `${provider.provider.toUpperCase()} PROVIDER` : "NO MODEL KEY"}
          {matches.length > 0 ? ` · ${matches.length} MATCHES SAVED` : ""}
        </span>
      </footer>
    </div>
  );
}
