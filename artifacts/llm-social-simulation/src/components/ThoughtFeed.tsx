import { Brain, Braces, Cpu } from "lucide-react";
import type { RawJsonEntry, ThoughtEntry } from "@/game/engine";
import { cn } from "@/lib/utils";

interface ThoughtFeedProps {
  /** The engine's thought ring buffer, oldest first. */
  thoughts: ThoughtEntry[];
  /** Every raw model reply this match, oldest first (rejected ones included). */
  rawJsons?: RawJsonEntry[];
  /** Spectator runs get a taller panel — the feed is the main event there. */
  spectator?: boolean;
  /** Phone layout: shorter panel, tighter rows. */
  compact?: boolean;
  className?: string;
}

/** Simulation clock as MM:SS, matching the meeting timer's format. */
function clock(t: number): string {
  const total = Math.floor(t);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/** Pretty-print raw model output; returns the original when it is not JSON. */
function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Small source pill: where the decision came from. */
function SourcePill({ source }: { source: ThoughtEntry["source"] }) {
  if (source === "model") {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-signal-dim/60 bg-signal/10 px-1.5 py-px text-[9px] uppercase tracking-wider text-signal">
        <Cpu className="h-2.5 w-2.5" aria-hidden />
        model
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800/60 px-1.5 py-px text-[9px] uppercase tracking-wider text-slate-500">
      heuristic
    </span>
  );
}

/** The raw model reply block, exactly as the provider returned it. */
function RawJson({ json }: { json: string }) {
  const body = pretty(json);
  return (
    <pre
      className="ml-[3.1rem] mt-1 max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-void-700 bg-void-950/90 p-2 font-mono text-[10px] leading-relaxed text-signal/80"
      aria-label="Raw model JSON output"
    >
      {body}
    </pre>
  );
}

/**
 * The agent thought feed: every AI decision (action + its own reasoning), and
 * for live-model decisions the raw JSON the model actually emitted — newest
 * first so the latest thought is always visible without scrolling. Data comes
 * from `Snapshot.thoughts`, which the engine fills in `recordDecision()` and
 * in `speak()` (meeting lines); the JSON rides along from the `onRaw` hook in
 * `src/ai/decision.ts`.
 */
export function ThoughtFeed({
  thoughts,
  rawJsons,
  spectator = false,
  compact = false,
  className,
}: ThoughtFeedProps) {
  const items = [...thoughts].reverse();

  return (
    <section
      className={cn(
        "rounded-xl border border-void-700 bg-void-950/80 backdrop-blur-sm",
        className,
      )}
      aria-label="Agent thought feed"
    >
      <header className="flex items-center justify-between border-b border-void-800 px-3 py-2">
        <span className="flex items-center gap-2 text-[10px] tracking-[0.2em] text-slate-500">
          <Brain className="h-3.5 w-3.5 text-signal" />
          AGENT THOUGHTS
        </span>
        <span className="flex items-center gap-2 text-[10px] tracking-widest text-slate-600">
          <Braces className="h-3 w-3" aria-hidden />
          {spectator ? "FULL DECK VIEW" : "LIVE"}
          <span
            aria-hidden
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              spectator ? "bg-signal" : "bg-signal/60 animate-pulse",
            )}
          />
        </span>
      </header>

      <ul
        className={cn(
          "space-y-2 overflow-y-auto px-3 py-2",
          compact ? "max-h-40" : spectator ? "max-h-96" : "max-h-72",
        )}
      >
        {items.length === 0 && (
          <li className="py-1 text-[11px] text-slate-600">
            The crew is still getting its bearings — decisions will appear here.
          </li>
        )}
        {items.map((entry) => (
          <li key={entry.id} className="text-[11px] leading-snug">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-mono text-[10px] tabular-nums text-slate-600">
                {clock(entry.t)}
              </span>
              <span className="flex items-center gap-1.5 font-semibold text-slate-300">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.name}
              </span>
              <SourcePill source={entry.source} />
              <span className="text-slate-400">{entry.action}</span>
            </div>
            {entry.reasoning && (
              <p className="ml-[3.1rem] text-[10px] italic text-slate-500">
                “{entry.reasoning}”
              </p>
            )}
            {entry.json && <RawJson json={entry.json} />}
          </li>
        ))}
      </ul>

      {rawJsons && rawJsons.length > 0 && (
        <details className="border-t border-void-800 px-3 py-2">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[10px] tracking-[0.2em] text-slate-500 transition-colors hover:text-slate-300">
            <Braces className="h-3 w-3 text-signal" aria-hidden />
            RAW MODEL OUTPUT ({rawJsons.length})
          </summary>
          <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
            {rawJsons.map((r) => (
              <li key={r.id}>
                <div className="flex items-baseline gap-2 text-[10px]">
                  <span className="font-mono tabular-nums text-slate-600">{clock(r.t)}</span>
                  <span className="flex items-center gap-1.5 font-semibold text-slate-400">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: r.color }}
                    />
                    {r.name}
                  </span>
                </div>
                <pre
                  className="mt-1 max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md border border-void-700 bg-void-950/90 p-2 font-mono text-[10px] leading-relaxed text-signal/80"
                  aria-label={`Raw model JSON output from ${r.name}`}
                >
                  {pretty(r.text)}
                </pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
