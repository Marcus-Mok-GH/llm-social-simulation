import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UMBRA_DECK_MAP } from "@/game/map";
import { isMovementKey } from "@/game/input";
import { GameEngine, type Snapshot } from "@/game/engine";
import { rankSuspects } from "@/game/perception";
import { saveMatch, type MatchRecord } from "@/game/persistence";
import { drawMap } from "@/game/render/renderMap";
import { useIsMobile } from "@/hooks/use-mobile";
import { GameHud, TaskRail } from "./GameHud";
import { Briefing, EndScreen, type RosterRow } from "./GameOverlays";
import { MeetingOverlay } from "./MeetingOverlay";
import { TaskModal } from "./TaskModal";
import { ThoughtFeed } from "./ThoughtFeed";
import { TouchControls } from "./TouchControls";
import { cn } from "@/lib/utils";

/** Vertical space reserved above (HUD chips, task meter, task chip). */
const HUD_BAND = 150;
/** Space reserved below the deck for the log, prompt and thumb controls. */
const CONTROL_BAND = 205;

/** The official Skeld artwork shown as the deck, served from `public/`. */
const SKELD_MAP_IMAGE = `${import.meta.env?.BASE_URL ?? "/"}skeld-map.webp`;

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
  const isMobile = useIsMobile();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLImageElement | null>(null);

  const roster: RosterRow[] = useMemo(
    () =>
      engine.actors.map((a) => ({
        key: a.key,
        name: a.name,
        color: a.color,
        isPlayer: a.isPlayer,
        role: a.role,
        model: a.cfg?.model ?? null,
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
    // Where the map sits vertically when the stage is taller than the deck.
    let biasY = 0.5;

    // The artwork is the map, so load it once and hand it to the renderer. The
    // frame loop skips it until it has decoded, so the first frames just show
    // the dark deck rather than throwing on an incomplete image.
    const bg = new Image();
    bg.src = SKELD_MAP_IMAGE;
    bgRef.current = bg;

    const resize = () => {
      cssW = Math.max(1, Math.floor(wrap.clientWidth));
      // On phones keep the stage inside the viewport so the HUD and touch
      // controls below the fold don't push the canvas off screen. Landscape
      // phones are wider than 768px, so also honour a coarse pointer.
      const coarse =
        (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
        false;
      const touchLayout = coarse || window.innerWidth < 768;
      const byWidth = cssW * (UMBRA_DECK_MAP.height / UMBRA_DECK_MAP.width);
      // How much room the stage has from its top edge to the bottom of the
      // viewport. On desktop the deck grows into all of it at the largest size
      // that fits without scrolling (computeTransform letterboxes the
      // remainder) — this sizing backs the spectator full-deck view; during
      // play the follow camera crops and zooms inside the same canvas.
      const docTop = wrap.getBoundingClientRect().top + window.scrollY;
      const fitH = Math.max(240, window.innerHeight - docTop - 16);
      let byLayout = byWidth;
      biasY = 0.5;
      if (touchLayout) {
        const vh = window.innerHeight;
        if (cssW <= vh) {
          // Portrait phones: the deck fits the width (contain), so reserve a
          // band above it for the HUD and a larger band below for the thumb
          // controls instead of letting both cover the map.
          byLayout = Math.min(byWidth + HUD_BAND + CONTROL_BAND, vh * 0.9);
          const leftover = Math.max(1, byLayout - byWidth);
          biasY = Math.min(0.6, HUD_BAND / leftover);
        } else {
          // Landscape phones: the deck is height-fit and fills the stage; the
          // HUD overlays it, but never let the stage exceed the viewport.
          byLayout = Math.min(byWidth, vh * 0.85);
        }
      } else {
        // On a short window the chrome is a big share of the height, and a
        // strict fit would shrink the deck to a stamp — there, let it run past
        // the fold (scrolling a little) instead of getting smaller.
        byLayout = Math.min(byWidth, Math.max(fitH, window.innerHeight * 0.75));
      }
      cssH = Math.max(1, Math.round(byLayout));
      // Mobile GPUs fill pixels fast; cap DPR hard to keep the 60 fps loop.
      dpr = Math.min(window.devicePixelRatio || 1, touchLayout ? 1.5 : 2);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.height = `${cssH}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    // Window height changes do not resize the wrapper, and the fit depends on
    // the viewport, so listen for those directly.
    window.addEventListener("resize", resize);

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
        biasY,
        background: bg.complete && bg.naturalWidth > 0 ? bg : null,
        // The camera follows the human player at a fixed zoom, re-read every
        // frame so it tracks movement and clamps at the deck edges. A
        // spectator watches the station itself: no camera target, no avatar,
        // and the fog gate below lifts so the whole deck (and everyone on it)
        // is visible.
        camera: engine.spectator ? null : { x: engine.player.x, y: engine.player.y },
        player: engine.spectator ? null : engine.player,
        playerAlive: engine.playerActor.alive,
        crewmates: engine.crewmates.filter((c) => alive.has(c)),
        imposters: engine.imposters.filter((i) => alive.has(i)),
        bodies: engine.bodies,
        fog:
          engine.phase === "playing" && !engine.spectator
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
      window.removeEventListener("resize", resize);
      observer.disconnect();
      engine.onMatchEnd = null;
      bgRef.current = null;
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
        // Hand back to the keyboard: drop the stick so a released thumb can't
        // resume driving the player once the key comes up. Only movement keys
        // do this — pressing `e` or Shift must not stop a held joystick.
        engine.touchMove = null;
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
      engine.touchMove = null;
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
    <div className={cn(className)}>
      <div className="relative">
        <div className="flex items-stretch gap-3">
          {/* Deck column: the canvas plus the HUD, which only overlays this
              column — the task rail beside it must stay outside that scope. */}
          <div className="relative min-w-0 flex-1">
            <div ref={wrapRef} className="w-full">
              <canvas
                ref={canvasRef}
                role="img"
                aria-label="The Skeld deck map — a playable social-deduction match with fog of war"
                className="block w-full rounded-xl border border-void-700 bg-void-950"
              />
            </div>

            <GameHud
              snap={snap}
              compact={isMobile}
              analyst={analyst}
              onToggleAnalyst={() => {
                engine.analystView = !engine.analystView;
                setAnalyst(engine.analystView);
                sync();
              }}
              spectator={snap.spectator}
              onToggleSpectate={() => {
                engine.enterSpectator();
                sync();
              }}
            />
          </div>

          {/* The player's task list sits beside the deck on desktop so it
              never covers the map; phones keep the collapsible HUD chip. */}
          {!isMobile && (
            <TaskRail tasks={snap.tasks} isImposter={snap.role === "imposter"} />
          )}
        </div>

        {isMobile &&
          snap.phase === "playing" &&
          !snap.spectator &&
          !snap.meeting &&
          !snap.activeTask && <TouchControls engine={engine} snap={snap} onAction={sync} />}

        {snap.phase === "briefing" && (
          <Briefing
            role={snap.role}
            roster={roster}
            compact={isMobile}
            onStart={() => {
              engine.begin();
              sync();
            }}
            onSpectate={() => {
              engine.begin(true);
              sync();
            }}
          />
        )}

        {snap.meeting && (
          <MeetingOverlay
            meeting={snap.meeting}
            spectator={snap.spectator}
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

      {/* The thought feed lives in normal flow below the deck (and below the
          meeting/end overlays), so it never fights the HUD for map space. */}
      <ThoughtFeed
        className="mt-3"
        thoughts={snap.thoughts}
        rawJsons={snap.rawJsons}
        spectator={snap.spectator}
        compact={isMobile}
      />
    </div>
  );
}
