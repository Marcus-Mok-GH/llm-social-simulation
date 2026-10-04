import { useEffect, useRef } from "react";
import { createCrewmates, updateCrewmate } from "@/game/crewmate";
import { createImposters, updateImposter } from "@/game/imposter";
import { inputVectorFromKeys, isMovementKey } from "@/game/input";
import { UMBRA_DECK_MAP } from "@/game/map";
import { buildNavGrid } from "@/game/navigation";
import { createPlayer, updatePlayer } from "@/game/player";
import { drawMap } from "@/game/render/renderMap";
import { cn } from "@/lib/utils";

interface MapCanvasProps {
  className?: string;
}

const CREW_COUNT = 4;
const IMPOSTER_COUNT = 2;

/**
 * Hosts the deck-map view, the local player and the AI crewmates. A
 * requestAnimationFrame loop advances the player from keyboard input and each
 * crewmate from its own pathfinding/task state machine, then redraws.
 */
export function MapCanvas({ className }: MapCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const coordRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const player = createPlayer(UMBRA_DECK_MAP);
    const grid = buildNavGrid(UMBRA_DECK_MAP);
    const crewmates = createCrewmates(UMBRA_DECK_MAP, CREW_COUNT);
    const imposters = createImposters(UMBRA_DECK_MAP, IMPOSTER_COUNT);
    const keys = new Set<string>();

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

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (isMovementKey(key)) {
        keys.add(key);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys.delete(e.key.toLowerCase());
    };
    const onBlur = () => keys.clear();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      updatePlayer(UMBRA_DECK_MAP, player, inputVectorFromKeys(keys), dt);
      for (const agent of crewmates) {
        updateCrewmate(UMBRA_DECK_MAP, grid, agent, dt);
      }
      for (const imp of imposters) {
        updateImposter(UMBRA_DECK_MAP, grid, imp, crewmates, dt);
      }

      drawMap(ctx, UMBRA_DECK_MAP, cssW, cssH, dpr, { player, crewmates, imposters });

      if (coordRef.current) {
        coordRef.current.textContent = `${Math.round(player.x)}, ${Math.round(player.y)}`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return (
    <div ref={wrapRef} className={cn("w-full", className)}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${UMBRA_DECK_MAP.name} deck map with a player you can move, ${CREW_COUNT} AI crewmates and ${IMPOSTER_COUNT} AI imposters`}
        className="block w-full rounded-xl border border-void-700 bg-void-950"
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11px]">
        <span className="flex items-center gap-2 tracking-widest text-slate-500">
          <kbd className="rounded border border-void-700 bg-void-900 px-1.5 py-0.5 text-slate-300">
            W
          </kbd>
          <kbd className="rounded border border-void-700 bg-void-900 px-1.5 py-0.5 text-slate-300">
            A
          </kbd>
          <kbd className="rounded border border-void-700 bg-void-900 px-1.5 py-0.5 text-slate-300">
            S
          </kbd>
          <kbd className="rounded border border-void-700 bg-void-900 px-1.5 py-0.5 text-slate-300">
            D
          </kbd>
          <span>or arrow keys to move</span>
        </span>
        <span className="flex items-center gap-3 font-mono tracking-wider text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-signal" />
            YOU
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-hazard" />
            {CREW_COUNT} AI CREW
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-[#b21e35]" />
            {IMPOSTER_COUNT} AI IMPOSTER
          </span>
          <span>
            POS <span ref={coordRef} className="text-signal">840, 340</span>
          </span>
        </span>
      </div>
    </div>
  );
}
