import { FileText, PenLine, TriangleAlert } from "lucide-react";
import type { StationLogEntry } from "@/game/creative";
import { cn } from "@/lib/utils";

interface StationLogProps {
  /** The engine's public station log, oldest first. */
  entries: StationLogEntry[];
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
 * The station log: the deck's shared document.
 *
 * A handful of consoles ask the AI crew to *write* something rather than wait
 * out a timer — a scan readout, an intercept summary, a note on what was in the
 * hold. Those entries are public to every agent (they can be quoted in a
 * meeting), so this panel is not decoration: it is where the audience watches
 * the crew invent a shared reality, and where an impostor files a cover story
 * next to it.
 */
export function StationLog({ entries, compact = false, className }: StationLogProps) {
  // Newest first: the newest entry is the one worth reading, and it should not
  // require a scroll to find.
  const items = [...entries].reverse();

  return (
    <section
      className={cn(
        "rounded-xl border border-void-700 bg-void-950/80 backdrop-blur-sm",
        className,
      )}
      aria-label="Station log"
    >
      <header className="flex items-center justify-between border-b border-void-800 px-3 py-2">
        <span className="flex items-center gap-2 text-[10px] tracking-[0.2em] text-slate-500">
          <FileText className="h-3.5 w-3.5 text-signal" aria-hidden />
          STATION LOG
        </span>
        <span className="text-[10px] tracking-widest text-slate-600">
          {entries.length === 0 ? "NO ENTRIES" : `${entries.length} FILED`}
        </span>
      </header>

      <ul className={cn("space-y-2 overflow-y-auto px-3 py-2", compact ? "max-h-44" : "max-h-64")}>
        {items.length === 0 && (
          <li className="py-1 text-[11px] leading-snug text-slate-600">
            Four consoles — MedBay, Communications, O2 and Storage — ask the crew
            to write a line instead of waiting out a timer. Those entries land
            here, and every agent can read them.
          </li>
        )}
        {items.map((entry) => (
          <li key={entry.id} className="rounded-lg border border-void-800 bg-void-900/60 p-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-mono text-[10px] tabular-nums text-slate-600">
                {clock(entry.t)}
              </span>
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-300">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.name}
              </span>
              <span className="text-[10px] tracking-wider text-slate-600">
                {entry.label} · {entry.room}
              </span>
              {entry.faked && (
                <span
                  className="inline-flex items-center gap-1 rounded border border-[#ff4d6a]/50 bg-[#ff4d6a]/10 px-1.5 py-px text-[9px] uppercase tracking-wider text-[#ff8a9c]"
                  title="Written by an agent that was faking the console"
                >
                  <TriangleAlert className="h-2.5 w-2.5" aria-hidden />
                  claimed
                </span>
              )}
              <span className="ml-auto inline-flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-600">
                <PenLine className="h-2.5 w-2.5" aria-hidden />
                {entry.source === "model" ? "written" : "template"}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-slate-300">“{entry.text}”</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
