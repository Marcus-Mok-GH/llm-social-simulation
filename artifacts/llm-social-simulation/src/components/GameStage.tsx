import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UMBRA_DECK_MAP } from "@/game/map";
import { isMovementKey } from "@/game/input";
import { GameEngine, type Snapshot } from "@/game/engine";
import { rankSuspects } from "@/game/perception";
import { saveMatch, type MatchRecord } from "@/game/persistence";
import { drawMap } from "@/game/render/renderMap";
import { GameHud } from "./GameHud";
import { Briefing, EndScreen, type RosterRow } from "./GameOverlays";
import { MeetingOverlay } from "./MeetingOverlay";
import { TaskModal } from "./TaskModal";
import { cn } from "@/lib/utils";

interface GameStageProps {
  className?: string;
  history?: MatchRecord[];
  onHistoryChange?: (matches: MatchRecord[]) => void;
}

function buildRecord(engine: GameEngine, winner: "crew" | "imposter"): MatchRecord {
  return {
    id: `${winner}-${Date.now()}`,
    startedAt: engine.startedAt,
    endedAt: Date.now(),
    durationSec: Math.round(engine.time),
    winner,
    playerRole: engine.playerActor.role,
    roster: engine.actors.map((a) => ({
      key: a.key,
      name: a.name,
      role: a.role,
      alive: a.alive,
    })),
    meetings: engine.meetingsHeld,
    ejects: engine.ejects,
    tasksComplete: engine.taskComplete,
    tasksTotal: engine.taskTotal,
    llm: { calls: engine.llmCalls, fallbacks: engine.llmFallbacks },
    transcript: engine.messages.map((m) => ({ t: m.t, who: m.speakerName, text: m.text })),
    beliefs: engine.actors.map((a) => ({
      key: a.key,
      name: a.name,
      role: a.role,
      suspects: rankSuspects(a.mind, 0)
        .slice(0, 3)
        .map((s) => ({
          name: engine.names[s.key] ?? s.key,
          score: Number(s.score.toFixed(3)),
        })),
      observations: a.mind.memories.length,
    })),
  };
}

/**
 * Hosts the canvas, the engine loop and every overlay. The engine is the only
 * source of truth; React renders a 10 Hz snapshot of it, which keeps the
 * simulation at full frame rate while the UI stays cheap.
 */
export function GameStage({ className, history, onHistoryChange }: GameStageProps) {
  const [engine, setEngine] = useState(() => new GameEngine());
  const [snap, setSnap] = useState<Snapshot>(() => engine.snapshot());
  const [analyst, setAnalyst] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const roster: RosterRow[] = useMemo(
    () =>
      engine.actors.map((a) => ({
        key: a.key,
        name: a.name,
        color: a.color,
        isPlayer: a.isPlayer,
        role: a.role,
      })),
    [engine],
  );

  const sync = useCallback(() => setSnap(engine.snapshot()), [engine]);

  // --- render + simulation loop ------------------------------------------
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cssW = 1;
    let cssH = 1;
    let dpr = 1;

    const resize = () => {
      cssW = Math.max(1, Math.floor(wrap.clientWidth));
      cssH = Math.round(cssW * (UMBRA_DECK_MAP.height / UMBRA_DECK_MAP.width));
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = `${cssH}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    engine.onMatchEnd = (winner) => {
      const record = buildRecord(engine, winner);
      onHistoryChange?.(saveMatch(record));
    };

    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      engine.tick(dt);

      const alive = new Set(engine.actors.filter((a) => a.alive).map((a) => a.entity));
      drawMap(ctx, UMBRA_DECK_MAP, cssW, cssH, dpr, {
        player: engine.player,
        playerAlive: engine.playerActor.alive,
        crewmates: engine.crewmates.filter((c) => alive.has(c)),
        imposters: engine.imposters.filter((i) => alive.has(i)),
        bodies: engine.bodies,
        fog:
          engine.phase === "playing"
            ? { polygon: engine.visionPolygon(), grid: engine.vis }
            : null,
        revealRoles: engine.analystView,
      });

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const uiTimer = window.setInterval(sync, 100);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(uiTimer);
      observer.disconnect();
      engine.onMatchEnd = null;
    };
  }, [engine, sync, onHistoryChange]);

  // --- keyboard ------------------------------------------------------------
  useEffect(() => {
    const typing = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA"));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const key = e.key.toLowerCase();

      if (isMovementKey(key)) {
        engine.setKey(key, true);
        e.preventDefault();
        return;
      }
      if (key === "e") {
        engine.setKey("e", true);
        if (!e.repeat) engine.interact();
        return;
      }
      if (key === " ") {
        engine.setKey(" ", true);
        if (!e.repeat) engine.playerKill();
        e.preventDefault();
        return;
      }
      if (key === "r" && !e.repeat) engine.report();
      if (key === "q" && !e.repeat) engine.triggerSabotage();
    };

    const onKeyUp = (e: KeyboardEvent) => engine.setKey(e.key.toLowerCase(), false);
    const onBlur = () => {
      for (const k of [...engine.keys]) engine.setKey(k, false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [engine]);

  const restart = (asImposter: boolean) => {
    const next = new GameEngine({ playerIsImposter: asImposter });
    setEngine(next);
    setSnap(next.snapshot());
    setAnalyst(false);
  };

  return (
    <div className={cn("relative", className)}>
      <div ref={wrapRef} className="w-full">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Umbra Station deck map — a playable social-deduction match with fog of war"
          className="block w-full rounded-xl border border-void-700 bg-void-950"
        />
      </div>

      <GameHud
        snap={snap}
        analyst={analyst}
        onToggleAnalyst={() => {
          engine.analystView = !engine.analystView;
          setAnalyst(engine.analystView);
          sync();
        }}
        llmOn={snap.llm.enabled}
        onToggleLlm={() => {
          engine.toggleLlm(!snap.llm.enabled);
          sync();
        }}
      />

      {snap.phase === "briefing" && (
        <Briefing
          role={snap.role}
          playerName={snap.playerName}
          roster={roster}
          onStart={() => {
            engine.begin();
            sync();
          }}
        />
      )}

      {snap.meeting && (
        <MeetingOverlay
          meeting={snap.meeting}
          onSay={(text) => {
            engine.playerSay(text);
            sync();
          }}
          onVote={(key) => {
            engine.playerVote(key);
            sync();
          }}
          onAdvance={() => {
            engine.advanceMeeting();
            sync();
          }}
        />
      )}

      {snap.activeTask && (
        <TaskModal
          label={snap.activeTask.label}
          room={snap.activeTask.room}
          kind={snap.activeTask.kind}
          onComplete={() => {
            engine.completeActiveTask();
            sync();
          }}
          onFail={() => {
            engine.cancelActiveTask();
            sync();
          }}
        />
      )}

      {snap.phase === "ended" && (
        <EndScreen snap={snap} history={history ?? []} onRestart={restart} />
      )}
    </div>
  );
}
