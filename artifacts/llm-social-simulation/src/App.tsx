import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Play, Radio, Swords, Trophy } from "lucide-react";
import { modelDisplayName, readProviders } from "@/ai/llm";
import { MAP_LEGEND, POI_LEGEND_COLORS } from "@/game/render/renderMap";
import { UMBRA_DECK_MAP } from "@/game/map";
import { loadLegacy } from "@/game/legacy";
import { loadMatches, type MatchRecord } from "@/game/persistence";
import { GameStage } from "@/components/GameStage";
import { cn } from "@/lib/utils";

/** The provider every AI agent runs on, chosen from the environment. */
const provider = readProviders()[0] ?? null;

/** The deck's seat colors — the same family the sprites wear in the match. */
const CAST_COLORS = [
  "#e0463c",
  "#3b82f6",
  "#22c55e",
  "#eab308",
  "#f97316",
  "#a855f7",
  "#38e1c8",
  "#ec4899",
  "#60a5fa",
];

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

/** One cast card: a model, its seat colour, and the role the engine will cast. */
function CastCard({
  name,
  color,
  traitor,
}: {
  name: string;
  color: string;
  traitor: boolean;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-xl border px-3 py-2.5 backdrop-blur-sm transition",
        traitor
          ? "border-[#ff4d6a]/50 bg-[#ff4d6a]/10 hover:border-[#ff4d6a]/80"
          : "border-void-700 bg-void-950/70 hover:border-slate-500",
      )}
      title={traitor ? "The engine only ever hands the knife to this model" : undefined}
    >
      <span
        className="h-6 w-6 shrink-0 rounded-full border-2 border-void-950"
        style={{ backgroundColor: color }}
      />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-slate-100">
          {name}
        </span>
        <span
          className={cn(
            "block text-[9px] tracking-[0.2em]",
            traitor ? "text-[#ff8a9c]" : "text-slate-500",
          )}
        >
          {traitor ? "DESIGNATED IMPOSTOR" : "CREW POOL"}
        </span>
      </span>
    </li>
  );
}

interface StandingRow {
  name: string;
  games: number;
  wins: number;
  eliminations: number;
  mislynched: number;
  winRate: number;
}

/**
 * The ladder: every finished shift folds into the cross-match ledger, so this
 * is a real leaderboard — wins, mislynches and win rate across all recorded
 * shifts, the same data the agents' grudges are built from.
 */
function useStandings(matches: MatchRecord[]): { shifts: number; rows: StandingRow[] } {
  return useMemo(() => {
    const ledger = loadLegacy();
    const rows = Object.values(ledger.agents)
      .filter((a) => a.games > 0)
      .map((a) => ({
        name: a.name,
        games: a.games,
        wins: a.wins,
        eliminations: a.eliminations,
        mislynched: a.mislynched,
        winRate: a.wins / a.games,
      }))
      .sort((x, y) => y.winRate - x.winRate || y.games - x.games)
      .slice(0, 8);
    return { shifts: ledger.shifts, rows };
    // A finished match is what re-folds the ledger — its count is the signal.
  }, [matches.length]);
}

const FEATURES: { tag: string; title: string; body: string }[] = [
  {
    tag: "PERCEPTION",
    title: "They only see what the fog allows",
    body: "Line-of-sight vision with wall occlusion. No agent — and no audience cam — can read a room nobody has looked into.",
  },
  {
    tag: "BELIEF",
    title: "Every vote is auditable",
    body: "Votes are computed from each agent's suspicion model, never written by the LLM. What they say and what they believe can be checked against each other.",
  },
  {
    tag: "DECEPTION",
    title: "Four traitor playbooks",
    body: "Wire-puller, provocateur, confidant, ghost. Structured accuse / vouch / alibi claims — and a crew whose own memory can catch the lie.",
  },
  {
    tag: "BROADCAST",
    title: "Cut like a show",
    body: "Emergency-meeting slams, the ejection screen with the role reveal, audience-only kill stings, a live play-by-play ticker, and spoken meeting lines.",
  },
  {
    tag: "CONFESSIONAL",
    title: "You hear what they really think",
    body: "Every decision and line carries a private thought — sealed while you're playing, legible the moment you spectate. The gap between the two channels is the show.",
  },
  {
    tag: "LEDGER",
    title: "They remember the last shift",
    body: "Wins, eliminations and grudges persist across matches. The agent voted out last time opens this one already watching every name on the ballot.",
  },
];

/**
 * The shell: a broadcast front door — title card, cast, standings, what makes
 * the shift watchable — and the stage itself, one scroll down. The game stays
 * mounted so a refresh lands straight back in the running shift.
 */
export default function App() {
  const [matches, setMatches] = useState<MatchRecord[]>(() => loadMatches());
  const { shifts, rows } = useStandings(matches);

  const cast = useMemo(() => {
    if (!provider) return [];
    return provider.models.map((id, i) => ({
      name: modelDisplayName(id),
      color: CAST_COLORS[i % CAST_COLORS.length],
      traitor: provider.imposterModels.includes(id),
    }));
  }, []);

  const toStage = () => {
    document.getElementById("stage")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-3 sm:px-6 sm:py-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-void-800 pb-2">
        <div className="flex items-baseline gap-3">
          <h1 className="font-display text-base font-bold tracking-[0.3em] text-slate-100">
            UMBRA STATION
          </h1>
          <span className="text-[11px] tracking-widest text-slate-600">
            LLM SOCIAL SIMULATION
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-[10px] font-bold tracking-[0.25em] text-[#ff5a6e]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#ff5a6e]" />
            ON AIR
          </span>
          <ProviderStatus />
        </div>
      </header>

      <main className="pt-4">
        {/* --- title card ------------------------------------------------- */}
        <section className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <p className="text-[11px] font-bold tracking-[0.35em] text-hazard">
              THE AI SOCIAL-DEDUCTION BROADCAST · DECK K7
            </p>
            <motion.h2
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="mt-3 font-display text-3xl font-black leading-[1.05] text-white sm:text-5xl"
            >
              Trust no one
              <span className="block text-signal">aboard the station.</span>
            </motion.h2>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-400">
              Ten seats on The Skeld: you, eight crewmates and two hidden
              impostors that only ever get played by the same two models. Every
              AI sees only what its own eyes allow, remembers exactly that, and
              argues for its life in the meeting — each running on a different
              model, with its own voice, its own lies, and last shift's grudges
              still warm.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={toStage}
                className="inline-flex items-center gap-2 rounded-lg bg-signal px-6 py-3 text-sm font-bold tracking-wider text-void-950 transition hover:bg-signal/90"
              >
                <Play className="h-4 w-4" />
                WATCH THE SHIFT
              </button>
              <button
                type="button"
                onClick={toStage}
                className="inline-flex items-center gap-2 rounded-lg border border-[#ff4d6a]/60 bg-[#ff4d6a]/10 px-6 py-3 text-sm font-bold tracking-wider text-[#ff8a9c] transition hover:bg-[#ff4d6a]/20"
              >
                <Swords className="h-4 w-4" />
                TAKE THE CREW SEAT
              </button>
            </div>

            <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-[10px] tracking-[0.2em] text-slate-500">
              <li>10 SEATS</li>
              <li>8 CREW · 2 IMPOSTORS</li>
              <li>FOG OF WAR</li>
              <li>{UMBRA_DECK_MAP.rooms.length} ROOMS</li>
              <li>{shifts > 0 ? `${shifts} SHIFTS AIRED` : "FIRST SHIFT PENDING"}</li>
            </ul>
          </div>

          {/* The "now playing" plate — the same facts the cast walks in with. */}
          <div className="rounded-2xl border border-void-700 bg-void-900/70 p-5">
            <p className="flex items-center gap-2 text-[10px] font-bold tracking-[0.3em] text-slate-500">
              <Radio className="h-3.5 w-3.5 text-signal" />
              CAST MANIFEST
            </p>
            {cast.length > 0 ? (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                {cast.map((c) => (
                  <CastCard key={c.name} name={c.name} color={c.color} traitor={c.traitor} />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs leading-relaxed text-slate-500">
                No model key configured — the station is running its scripted
                heuristic crew. Add a provider key to put real models in the
                seats.
              </p>
            )}
            <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
              Two seats are permanently the impostors: the engine never casts
              them as honest crew, so the traitors are always the same pair.
            </p>
          </div>
        </section>

        {/* --- standings --------------------------------------------------- */}
        <section className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="flex items-center gap-2 font-display text-sm font-bold tracking-[0.25em] text-slate-200">
              <Trophy className="h-4 w-4 text-hazard" />
              STANDINGS
            </h3>
            <p className="text-[10px] tracking-[0.2em] text-slate-600">
              FOLDED FROM EVERY FINISHED SHIFT
            </p>
          </div>

          {rows.length > 0 ? (
            <div className="mt-3 overflow-x-auto rounded-xl border border-void-700 bg-void-950/70">
              <table className="w-full min-w-[34rem] text-left text-xs">
                <thead>
                  <tr className="text-[10px] tracking-[0.2em] text-slate-600">
                    <th className="px-4 py-2 font-normal">#</th>
                    <th className="px-4 py-2 font-normal">MODEL</th>
                    <th className="px-4 py-2 text-right font-normal">SHIFTS</th>
                    <th className="px-4 py-2 text-right font-normal">WINS</th>
                    <th className="px-4 py-2 text-right font-normal">EJECTED</th>
                    <th className="px-4 py-2 text-right font-normal">MISLYNCHED</th>
                    <th className="px-4 py-2 text-right font-normal">WIN %</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.name} className="border-t border-void-800">
                      <td className="px-4 py-2 font-mono text-slate-600">{i + 1}</td>
                      <td className="px-4 py-2 font-semibold text-slate-200">{r.name}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-400">
                        {r.games}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-signal">
                        {r.wins}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-400">
                        {r.eliminations}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-hazard">
                        {r.mislynched}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-200">
                        {Math.round(r.winRate * 100)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 rounded-xl border border-dashed border-void-700 bg-void-950/50 px-4 py-5 text-center text-xs text-slate-500">
              No shifts on record yet — finish one and the cast starts keeping
              score of itself.
            </p>
          )}
        </section>

        {/* --- how the show works ------------------------------------------ */}
        <section className="mt-8">
          <h3 className="font-display text-sm font-bold tracking-[0.25em] text-slate-200">
            WHY IT IS WORTH WATCHING
          </h3>
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <li
                key={f.tag}
                className="rounded-xl border border-void-700 bg-void-900/60 p-4 transition hover:border-slate-600"
              >
                <p className="text-[9px] font-bold tracking-[0.3em] text-hazard">{f.tag}</p>
                <p className="mt-1.5 text-sm font-semibold text-slate-100">{f.title}</p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                  {f.body}
                </p>
              </li>
            ))}
          </ul>
        </section>

        {/* --- the stage ---------------------------------------------------- */}
        <section id="stage" className="mt-8 scroll-mt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1">
            <h3 className="font-display text-lg font-black leading-tight tracking-tight text-white sm:text-xl">
              The live shift
            </h3>
            <p className="max-w-3xl text-[11px] leading-snug text-slate-400 sm:text-xs">
              The station runs whether or not you watch — take the crew seat,
              or spectate with full vision and hear what they really think.
            </p>
          </div>

          <div className="mt-4">
            <GameStage history={matches} onHistoryChange={setMatches} />

            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[11px] text-slate-500">
              {MAP_LEGEND.map((entry) => (
                <li key={entry.kind} className="flex items-center gap-2">
                  <LegendSwatch kind={entry.kind} />
                  {entry.label}
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-void-800 pt-4 text-[10px] tracking-widest text-slate-600">
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
