import { useState, type ReactNode } from "react";
import { BrainCircuit, Eye } from "lucide-react";
import type { Snapshot } from "@/game/engine";
import { cn } from "@/lib/utils";

interface GameHudProps {
  snap: Snapshot;
  /** Phone/tablet layout: tasks move to the top, touch controls own the bottom. */
  compact?: boolean;
  analyst: boolean;
  onToggleAnalyst: () => void;
  llmOn: boolean;
  onToggleLlm: () => void;
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
  llmOn,
  onToggleLlm,
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
      {/* Top bar */}
      <div className="flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "rounded-full border px-3 py-1 text-[10px] font-bold tracking-[0.2em]",
              isImposter
                ? "border-[#ff4d6a]/60 bg-[#ff4d6a]/15 text-[#ff8a9c]"
                : "border-signal/50 bg-signal/10 text-signal",
            )}
          >
            {isImposter ? "IMPOSTER" : "CREW"} · {snap.playerName} ·{" "}
            {snap.playerAlive ? `${aliveCount} ALIVE` : "DEAD"}
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
            active={llmOn}
            onClick={onToggleLlm}
            title="Use the configured model provider for agent reasoning and meeting dialogue"
          >
            <BrainCircuit className="h-3 w-3" />
            {llmOn ? "LLM ON" : "LLM OFF"}
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

      {/* Sabotage banner */}
      {snap.sabotage && (
        <div className="mx-auto mt-3 w-full max-w-md px-3">
          <div className="rounded-lg border border-hazard/60 bg-hazard/15 px-3 py-2 backdrop-blur-sm">
            <div className="flex items-center justify-between text-[10px] tracking-widest text-hazard">
              <span className="animate-pulseGlow">
                {snap.sabotage.kind === "meltdown" ? "REACTOR MELTDOWN" : "GRID OVERLOAD"}
              </span>
              <span className="tabular-nums">
                {snap.sabotage.secondsLeft.toFixed(1)}s
              </span>
            </div>
            <div className="mt-1.5">
              <Meter value={snap.sabotage.fixProgress} tone="hazard" />
            </div>
            <p className="mt-1 text-[10px] text-hazard/80">
              {snap.sabotage.kind === "meltdown"
                ? "Repair at the reactor or life support — hold E."
                : "Repair at the power bay — hold E."}
            </p>
          </div>
        </div>
      )}

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

      {/* Tasks + prompt (desktop) / prompt above touch controls (compact) */}
      <div
        className={cn("absolute inset-x-0 bottom-0 p-3", compact && "pb-32")}
      >
        {!compact && (
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="w-64 max-w-full rounded-lg border border-void-700 bg-void-950/80 p-3 backdrop-blur-sm">
              <p className="mb-2 text-[10px] tracking-[0.2em] text-slate-500">YOUR TASKS</p>
              {snap.tasks.length === 0 ? (
                <p className="text-[11px] text-slate-600">
                  {isImposter ? "Blend in. Fake everything." : "No assignments."}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {snap.tasks.map((t) => (
                    <li
                      key={t.poiId}
                      className={cn(
                        "flex items-start gap-2 text-[11px]",
                        t.done ? "text-slate-600 line-through" : "text-slate-300",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                          t.done ? "bg-signal" : "bg-hazard",
                        )}
                      />
                      <span>
                        {t.label}
                        <span className="block text-[10px] text-slate-600">{t.room}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

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
