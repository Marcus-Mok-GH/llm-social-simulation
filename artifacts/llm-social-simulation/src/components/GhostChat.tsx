import { Ghost } from "lucide-react";
import type { ChatMessage } from "@/game/engine";
import { cn } from "@/lib/utils";

interface GhostChatProps {
  /** Ghost-channel messages, oldest first. */
  messages: ChatMessage[];
  /** The single ghost currently holding the channel, or null while it is quiet. */
  speaker: string | null;
  /**
   * Whether the channel may be read. Ghost chat is dead-only, so it is a
   * spoiler for anyone still in the living roster: shown while spectating or
   * after the verdict, sealed otherwise.
   */
  reveal: boolean;
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
 * The ghost channel: the dead AIs talking among themselves.
 *
 * The living never hear this lane, and the engine only ever lets one ghost hold
 * it at a time, so the header shows a single active speaker rather than a crowd.
 * Nothing said here moves a living agent's beliefs — it is a second show for the
 * gallery, next to the confessional.
 */
export function GhostChat({
  messages,
  speaker,
  reveal,
  compact = false,
  className,
}: GhostChatProps) {
  if (messages.length === 0 && speaker === null) return null;

  const items = [...messages].reverse();

  return (
    <section
      className={cn(
        "rounded-xl border border-void-700 bg-void-950/80 backdrop-blur-sm",
        className,
      )}
      aria-label="Ghost channel"
    >
      <header className="flex items-center justify-between border-b border-void-800 px-3 py-2">
        <span className="flex items-center gap-2 text-[10px] tracking-[0.2em] text-slate-500">
          <Ghost className="h-3.5 w-3.5 text-[#7dd3fc]" aria-hidden />
          GHOST CHANNEL
        </span>
        <span className="text-[10px] tracking-widest text-slate-600">
          {speaker ? (
            <span className="text-[#7dd3fc]">{speaker} IS SPEAKING</span>
          ) : (
            <span>{messages.length} TRANSMISSIONS</span>
          )}
        </span>
      </header>

      {!reveal ? (
        <p className="px-3 py-4 text-center text-[11px] leading-snug text-slate-500">
          The dead talk to each other in a lane the living never hear. It opens
          when you are spectating.
        </p>
      ) : (
        <ul
          className={cn(
            "space-y-1.5 overflow-y-auto px-3 py-2",
            compact ? "max-h-40" : "max-h-56",
          )}
        >
          {items.length === 0 && (
            <li className="py-1 text-[11px] text-slate-600">
              The dead have not spoken yet.
            </li>
          )}
          {items.map((m) => (
            <li key={m.id} className="flex gap-2 text-[11px] leading-snug">
              <span className="font-mono text-[9px] tabular-nums text-slate-600">
                {clock(m.t)}
              </span>
              <span
                className="shrink-0 font-semibold"
                style={{ color: m.color }}
              >
                {m.speakerName}
              </span>
              <span className="text-slate-400">{m.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
