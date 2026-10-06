import { useState, type ReactNode } from "react";
import { Eye, Ghost } from "lucide-react";
import type { Snapshot } from "@/game/engine";
import { cn } from "@/lib/utils";

interface GameHudProps {
  snap: Snapshot;
  /** Phone/tablet layout: tasks move to the top, touch controls own the bottom. */
  compact?: boolean;
  analyst: boolean;
  onToggleAnalyst: () => void;
  spectator: boolean;
  onToggleSpectate: () => void;
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
  onToggleSpectate,
}: GameHudProps) {
  const isImposter = snap.role === "imposter";
  const aliveCount = snap.alive.crew + snap.alive.imposter;
  const [tasksOpen, setTasksOpen] = useState(false);
  const tasksDone = snap.tasks.filter((t) => t.done).length;

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
              {Math.ceil(snap.sabotage.secondsLeft)} seconds left. Repair{" "}
              {snap.sabotage.kind === "meltdown"
                ? "at a hand scanner in Reactor"
                : "the panel in Electrical"}
              .
            </span>
          </div>
        </>
      )}

      {/* Top bar */}
      <div className="flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full border px-3 py-1 text-[10px] font-bold tracking-[0.2em]",
              spectator
                ? "border-[#a78bfa]/60 bg-[#a78bfa]/15 text-[#c4b5fd]"
                : isImposter
                  ? "border-[#ff4d6a]/60 bg-[#ff4d6a]/15 text-[#ff8a9c]"
                  : "border-signal/50 bg-signal/10 text-signal",
            )}
          >
            {spectator
              ? `SPECTATOR · ${snap.playerName} · FULL VISION`
              : `${isImposter ? "IMPOSTER" : "CREW"} · ${snap.playerName} · ${
                  snap.playerAlive ? `${aliveCount} ALIVE` : "DEAD"
                }`}
          </span>
        </div>

        <div className="pointer-events-auto flex flex-wrap items-center gap-2">
          <Chip
            active={analyst}
            onClick={onToggleAnalyst}
            title="Reveal each agent's current top suspect"
          >
            <Eye className="h-3 w-3" />
            ANALYST
          </Chip>
          <Chip
            active={spectator}
            onClick={onToggleSpectate}
            title={spectator ? "Spectating — restart to play again" : "Leave the match and watch with full deck vision"}
          >
            <Ghost className="h-3 w-3" />
            {spectator ? "SPECTATING" : "SPECTATE"}
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

      {/* Compact layout: the task list collapses to a chip under the meter so
          the deck keeps its space; opening it overlays the (fogged) map. */}
      {compact && (
        <div className="mx-auto mt-3 w-full max-w-md px-3">
          <button
            type="button"
            onClick={() => setTasksOpen((v) => !v)}
            aria-expanded={tasksOpen}
            className="flex w-full items-center justify-between rounded-lg border border-void-700 bg-void-950/80 px-3 py-2 text-[10px] tracking-[0.2em] text-slate-400 backdrop-blur-sm"
          >
            <span>
              YOUR TASKS · {tasksDone}/{snap.tasks.length}
            </span>
            <span className="text-signal">{tasksOpen ? "▾" : "▸"}</span>
          </button>
          {tasksOpen && (
            <div className="mt-1.5 max-h-32 overflow-y-auto rounded-lg border border-void-700 bg-void-950/85 p-2.5 backdrop-blur-sm">
              {snap.tasks.length === 0 ? (
                <p className="text-[11px] text-slate-600">
                  {isImposter ? "Blend in. Fake everything." : "No assignments."}
                </p>
              ) : (
                <ul className="space-y-1">
                  {snap.tasks.map((t) => (
                    <li
                      key={t.poiId}
                      className={cn(
                        "flex items-baseline gap-2 text-[11px]",
                        t.done ? "text-slate-600 line-through" : "text-slate-300",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          t.done ? "bg-signal" : "bg-hazard",
                        )}
                      />
                      <span>
                        {t.label}
                        <span className="text-slate-600"> · {t.room}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
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

      {/* Prompt + controls (desktop) / prompt above touch controls (compact) */}
      <div
        className={cn("absolute inset-x-0 bottom-0 p-3", compact && "pb-32")}
      >
        {!compact && (
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex-1 text-center">
              {snap.prompt && (
                <span className="inline-block rounded-lg border border-signal/40 bg-void-950/85 px-4 py-2 text-xs tracking-widest text-signal backdrop-blur-sm">
                  {snap.prompt}
                </span>
              )}
            </div>

            <div className="rounded-lg border border-void-700 bg-void-950/80 p-3 text-right backdrop-blur-sm">
              {isImposter && (
                <div className="space-y-1.5 text-[11px]">
                  <p className="flex items-center justify-end gap-2 text-slate-400">
                    KILL
                    <span
                      className={cn(
                        "font-mono tabular-nums",
                        snap.killCooldown > 0 ? "text-slate-600" : "text-signal",
                      )}
                    >
                      {snap.killCooldown > 0 ? `${snap.killCooldown.toFixed(0)}s` : "READY"}
                    </span>
                  </p>
                  <p className="flex items-center justify-end gap-2 text-slate-400">
                    SABOTAGE
                    <span
                      className={cn(
                        "font-mono tabular-nums",
                        snap.sabotageCooldown > 0 ? "text-slate-600" : "text-signal",
                      )}
                    >
                      {snap.sabotageCooldown > 0
                        ? `${snap.sabotageCooldown.toFixed(0)}s`
                        : "READY"}
                    </span>
                  </p>
                </div>
              )}
              <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
                WASD move · E interact
                <br />
                {isImposter ? "SPACE kill · Q sabotage · " : ""}R report
              </p>
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

      {/* LLM status (desktop keeps it pinned under the role chips) */}
      {!compact && (
        <div className="absolute left-3 top-[4.6rem] text-[10px] tracking-widest text-slate-600">
          {llmStatus}
        </div>
      )}
    </div>
  );
}

/**
 * Desktop task rail: a slim card parked beside the deck (outside the canvas)
 * instead of overlaying it, so the list never covers the map. Phones keep the
 * collapsible chip in the HUD instead.
 */
export function TaskRail({
  tasks,
  isImposter,
}: {
  tasks: Snapshot["tasks"];
  isImposter: boolean;
}) {
  const done = tasks.filter((t) => t.done).length;
  return (
    <aside className="w-44 shrink-0 self-start rounded-lg border border-void-700 bg-void-950/80 p-2.5 backdrop-blur-sm">
      <p className="mb-1.5 flex items-baseline justify-between text-[10px] tracking-[0.2em] text-slate-500">
        <span>YOUR TASKS</span>
        <span className="text-signal">
          {done}/{tasks.length}
        </span>
      </p>
      {tasks.length === 0 ? (
        <p className="text-[10px] leading-snug text-slate-600">
          {isImposter ? "Blend in. Fake everything." : "No assignments."}
        </p>
      ) : (
        <ul className="space-y-1">
          {tasks.map((t) => (
            <li
              key={t.poiId}
              className={cn(
                "flex items-start gap-1.5 text-[10px] leading-snug",
                t.done ? "text-slate-600 line-through" : "text-slate-300",
              )}
            >
              <span
                className={cn(
                  "mt-1 h-1 w-1 shrink-0 rounded-full",
                  t.done ? "bg-signal" : "bg-hazard",
                )}
              />
              <span>
                {t.label}
                <span className="block text-[9px] text-slate-600">{t.room}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
