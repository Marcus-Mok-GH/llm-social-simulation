import { Brain } from "lucide-react";
import type { ThoughtEntry } from "@/game/engine";
import { cn } from "@/lib/utils";

interface ThoughtFeedProps {
  /** The engine's thought ring buffer, oldest first. */
  thoughts: ThoughtEntry[];
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

/**
 * The agent thought feed: every AI decision (action + its own reasoning),
 * newest first so the latest thought is always visible without scrolling.
 * Data comes from `Snapshot.thoughts`, which the engine fills in
 * `recordDecision()` — model and heuristic intents both land here.
 */
export function ThoughtFeed({ thoughts, spectator = false, compact = false, className }: ThoughtFeedProps) {
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
          "space-y-1.5 overflow-y-auto px-3 py-2",
          compact ? "max-h-28" : spectator ? "max-h-56" : "max-h-40",
        )}
      >
        {items.length === 0 && (
          <li className="py-1 text-[11px] text-slate-600">
            The crew is still getting its bearings — decisions will appear here.
          </li>
        )}
        {items.map((entry) => (
          <li key={entry.id} className="text-[11px] leading-snug">
            <div className="flex items-baseline gap-2">
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
              <span className="text-slate-400">{entry.action}</span>
            </div>
            {entry.reasoning && (
              <p className="ml-[3.1rem] text-[10px] italic text-slate-500">
                “{entry.reasoning}”
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
