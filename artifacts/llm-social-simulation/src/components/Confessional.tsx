import { Eye, EyeOff, MessagesSquare, VenetianMask } from "lucide-react";
import type { ConfessionalEntry } from "@/game/engine";
import { cn } from "@/lib/utils";

interface ConfessionalProps {
  /** Per-agent private thoughts, oldest first. */
  entries: ConfessionalEntry[];
  /**
   * Whether the thoughts may be shown. The confessional is a spoiler: a traitor
   * is candid here and the crew never hears it. Off during a live match you are
   * playing, on while spectating or after the verdict.
   */
  reveal: boolean;
  /** Flip the gate. Only used when the panel is being hidden by choice. */
  onReveal: () => void;
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
 * The confessional: what each agent was actually thinking.
 *
 * The meeting transcript is what the crew hears. This is the other channel —
 * the same agent, the same second, the thought underneath the line. A crew
 * member's private note is usually just its real read of the room; a traitor's
 * is a cover story, and the gap between the two is the thing worth watching.
 *
 * It is behind a gate because it genuinely spoils the game: the crew cannot see
 * it, so neither can you while you are playing one of them.
 */
export function Confessional({
  entries,
  reveal,
  onReveal,
  compact = false,
  className,
}: ConfessionalProps) {
  const items = [...entries].reverse();
  const latestByAgent = new Map<string, number>();
  for (const entry of entries) latestByAgent.set(entry.key, entry.id);

  return (
    <section
      className={cn(
        "rounded-xl border border-void-700 bg-void-950/80 backdrop-blur-sm",
        className,
      )}
      aria-label="Agent confessional"
    >
      <header className="flex items-center justify-between border-b border-void-800 px-3 py-2">
        <span className="flex items-center gap-2 text-[10px] tracking-[0.2em] text-slate-500">
          <MessagesSquare className="h-3.5 w-3.5 text-[#c4b5fd]" aria-hidden />
          CONFESSIONAL
        </span>
        <span className="flex items-center gap-2 text-[10px] tracking-widest text-slate-600">
          {reveal ? (
            <>
              <Eye className="h-3 w-3" aria-hidden />
              PRIVATE CHANNEL
            </>
          ) : (
            <>
              <EyeOff className="h-3 w-3" aria-hidden />
              SEALED
            </>
          )}
        </span>
      </header>

      {!reveal ? (
        <div className="px-3 py-4 text-center">
          <p className="mx-auto max-w-sm text-[11px] leading-snug text-slate-500">
            Every agent keeps a private read of the room — what it really thinks
            while it talks. A traitor&apos;s is a cover story. Showing it would
            hand you the answer, so it stays sealed while you are playing.
          </p>
          <button
            type="button"
            onClick={onReveal}
            className="mt-3 inline-flex items-center gap-2 rounded-lg border border-[#a78bfa]/50 bg-[#a78bfa]/10 px-3 py-1.5 text-[10px] font-bold tracking-widest text-[#c4b5fd] transition hover:bg-[#a78bfa]/20"
          >
            <VenetianMask className="h-3 w-3" aria-hidden />
            REVEAL — SPOILS THIS MATCH
          </button>
        </div>
      ) : (
        <ul
          className={cn(
            "space-y-2 overflow-y-auto px-3 py-2",
            compact ? "max-h-52" : "max-h-72",
          )}
        >
          {items.length === 0 && (
            <li className="py-1 text-[11px] text-slate-600">
              The agents have not thought anything worth printing yet.
            </li>
          )}
          {items.map((entry) => (
            <li
              key={entry.id}
              className={cn(
                "rounded-lg border p-2",
                entry.concealing
                  ? "border-[#ff4d6a]/35 bg-[#ff4d6a]/[0.06]"
                  : "border-void-800 bg-void-900/60",
              )}
            >
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
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded border px-1.5 py-px text-[9px] uppercase tracking-wider",
                    entry.concealing
                      ? "border-[#ff4d6a]/50 bg-[#ff4d6a]/10 text-[#ff8a9c]"
                      : "border-signal-dim/60 bg-signal/10 text-signal",
                  )}
                >
                  <VenetianMask className="h-2.5 w-2.5" aria-hidden />
                  {entry.concealing ? "cover story" : "candid"}
                </span>
                {latestByAgent.get(entry.key) === entry.id && (
                  <span className="text-[9px] uppercase tracking-wider text-slate-600">
                    latest
                  </span>
                )}
              </div>
              <p className="mt-1 text-[10px] text-slate-500">{entry.action}</p>
              <p className="mt-0.5 text-[11px] italic leading-snug text-slate-300">
                “{entry.thought}”
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
