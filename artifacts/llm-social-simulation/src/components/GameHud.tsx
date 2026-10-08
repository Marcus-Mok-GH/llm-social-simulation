import type { ReactNode } from "react";
import { Eye, Volume2, VolumeX } from "lucide-react";
import type { Snapshot } from "@/game/engine";
import { canSpeak } from "./voice";
import { cn } from "@/lib/utils";

interface GameHudProps {
  snap: Snapshot;
  /** Phone/tablet layout: tasks move to the top, touch controls own the bottom. */
  compact?: boolean;
  analyst: boolean;
  onToggleAnalyst: () => void;
  spectator: boolean;
  /** The cast's TTS voices: on, the meeting is spoken aloud. */
  voice: boolean;
  onToggleVoice: () => void;
}

function Chip({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] tracking-widest transition",
        active
          ? "border-signal/60 bg-signal/15 text-signal"
          : "border-void-700 bg-void-900/70 text-slate-500 hover:text-slate-300",
      )}
    >
      {children}
    </button>
  );
}

function Meter({ value, tone }: { value: number; tone: "signal" | "hazard" }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-void-800">
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300",
          tone === "signal" ? "bg-signal" : "bg-hazard",
        )}
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

export function GameHud({
  snap,
  compact = false,
  analyst,
  onToggleAnalyst,
  spectator,
  voice,
  onToggleVoice,
}: GameHudProps) {
  const llmStatus = snap.llm.configured ? (
    <>
      {(snap.llm.provider ?? "").toUpperCase()} · {snap.llm.roster.length} MODELS ·{" "}
      {snap.llm.calls} CALLS
    </>
  ) : (
    <>HEURISTIC AGENTS — NO MODEL KEY</>
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-20 select-none">
      {/* Sabotage alarm. Instead of a card parked over the deck, the whole
          stage breathes red → clear → red until the fault is fixed; only a
          hairline countdown on the top edge touches the view. */}
      {snap.sabotage && (
        <>
          <div
            aria-hidden
            className={cn(
              "sabotage-flash absolute inset-0 -z-10",
              snap.sabotage.secondsLeft <= 10 && "sabotage-flash--critical",
            )}
          />
          <div
            className="absolute inset-x-0 top-0 h-[3px] bg-[#ff2d4d]/25"
            title={`${snap.sabotage.kind === "meltdown" ? "Reactor meltdown" : "Lights out"} — ${snap.sabotage.secondsLeft.toFixed(1)}s`}
          >
            <div
              className="h-full bg-[#ff2d4d]"
              style={{
                width: `${
                  Math.max(
                    0,
                    Math.min(1, snap.sabotage.secondsLeft / snap.sabotage.duration),
                  ) * 100
                }%`,
              }}
            />
            <span className="sr-only">
              {snap.sabotage.kind === "meltdown" ? "Reactor meltdown" : "Lights out"},{" "}
              {Math.ceil(snap.sabotage.secondsLeft)} seconds left.{" "}
              {snap.sabotage.kind === "meltdown"
                ? "Hold both hand scanners in Reactor at once by two different people"
                : "Repair the panel in Electrical"}
              .
            </span>
          </div>
        </>
      )}

      {/* Top bar */}
      <div className="flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* You hold no seat: the gallery badge is the whole identity now. */}
          <span className="rounded-full border border-[#a78bfa]/50 bg-[#a78bfa]/10 px-3 py-1 text-[10px] font-bold tracking-[0.2em] text-[#c4b5fd]">
            {spectator ? "GALLERY · SPECTATING" : "GALLERY"}
          </span>
        </div>

        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          {canSpeak() && (
            <Chip
              active={voice}
              onClick={onToggleVoice}
              title={
                voice
                  ? "Voices on — the cast speaks its meeting lines aloud"
                  : "Voices muted"
              }
            >
              {voice ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
              {voice ? "VOICE" : "MUTED"}
            </Chip>
          )}
          <Chip
            active={analyst}
            onClick={onToggleAnalyst}
            title="Reveal each agent's current top suspect"
          >
            <Eye className="h-3 w-3" />
            ANALYST
          </Chip>
        </div>
      </div>

      {/* Task bar */}
      <div className="mx-auto w-full max-w-md px-3">
        <div className="mb-1 flex items-center justify-between text-[10px] tracking-widest text-slate-500">
          <span>STATION TASKS</span>
          <span className="text-signal">{Math.round(snap.taskProgress * 100)}%</span>
        </div>
        <Meter value={snap.taskProgress} tone="signal" />
      </div>

      {/* Reactor meltdown needs two hands on two scanners at once. Show which
          pad is already covered so the crew knows to take the other one — the
          on-screen equivalent of "WAITING FOR SECOND USER". */}
      {snap.sabotage?.kind === "meltdown" && (
        <div className="mx-auto mt-2 w-full max-w-md px-3">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-[#ff4d6a]/50 bg-void-950/85 px-3 py-1.5 text-[10px] tracking-wider text-[#ff8a9c] backdrop-blur-sm">
            <span>REACTOR MELTDOWN</span>
            <span className="flex items-center gap-3">
              {snap.sabotage.fixPois.map((p) => (
                <span
                  key={p.id}
                  className="flex items-center gap-1.5"
                  title={`${p.label} — ${p.held ? "held" : "waiting for second user"}`}
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full",
                      p.held ? "bg-[#ff2d4d]" : "bg-slate-700",
                    )}
                  />
                  {p.held ? "HELD" : "OPEN"}
                </span>
              ))}
              <span className="tabular-nums text-[#ff4d6a]">
                {Math.round(snap.sabotage.fixProgress * 100)}%
              </span>
            </span>
          </div>
        </div>
      )}

      {/* Analyst panel */}
      {snap.analyst && (
        <div
          className={cn(
            "absolute rounded-lg border border-void-700 bg-void-950/85 p-3 backdrop-blur-sm",
            compact ? "inset-x-3 top-28" : "right-3 top-24 w-56",
          )}
        >
          <p className="mb-2 text-[10px] tracking-[0.2em] text-slate-500">
            BELIEF SNAPSHOT
          </p>
          <ul className="space-y-1.5">
            {snap.analyst.map((a) => (
              <li
                key={a.key}
                title={snap.llm.roster.find((r) => r.key === a.key)?.model ?? undefined}
                className="flex items-center justify-between gap-2 text-[10px]"
              >
                <span className="flex items-center gap-1.5 text-slate-300">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: a.color }}
                  />
                  {a.name}
                </span>
                <span className="text-right text-slate-500">
                  → {a.top}
                  <span className="ml-1 text-hazard">{Math.round(a.score * 100)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Prompt + station log (desktop) / prompt above the log (compact) */}
      <div
        className={cn("absolute inset-x-0 bottom-0 p-3", compact && "pb-32")}
      >
        {!compact && (
          <div className="flex flex-wrap items-end justify-center gap-3">
            <div className="flex-1 text-center">
              {snap.prompt && (
                <span className="inline-block rounded-lg border border-signal/40 bg-void-950/85 px-4 py-2 text-xs tracking-widest text-signal backdrop-blur-sm">
                  {snap.prompt}
                </span>
              )}
            </div>
          </div>
        )}

        {compact && snap.prompt && (
          <div className="text-center">
            <span className="inline-block max-w-full rounded-lg border border-signal/40 bg-void-950/85 px-3 py-1.5 text-[11px] tracking-wider text-signal backdrop-blur-sm">
              {snap.prompt}
            </span>
          </div>
        )}

        {/* Station log */}
        {snap.log.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-[10px] text-slate-600">
            {snap.log.slice(compact ? -1 : -3).map((line, i) => (
              <li key={`${i}-${line}`} className={cn(compact && "truncate")}>
                › {line}
              </li>
            ))}
          </ul>
        )}

        {compact && (
          <p className="mt-1.5 text-center text-[10px] tracking-widest text-slate-600">
            {llmStatus}
          </p>
        )}
      </div>

      {/* LLM status (desktop keeps it pinned under the badge row) */}
      {!compact && (
        <div className="absolute left-3 top-[4.6rem] text-[10px] tracking-widest text-slate-600">
          {llmStatus}
        </div>
      )}
    </div>
  );
}
