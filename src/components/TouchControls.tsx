import { useEffect, useRef, useState, type ReactNode } from "react";
import { Hand, Megaphone, Skull, Zap } from "lucide-react";
import type { GameEngine, Snapshot } from "@/game/engine";
import { cn } from "@/lib/utils";

interface TouchControlsProps {
  engine: GameEngine;
  snap: Snapshot;
  /** Push a fresh snapshot into React after a button changes engine state. */
  onAction: () => void;
}

/** Keep the knob inside the pad while the vector itself can reach the rim. */
const KNOB_TRAVEL = 0.62;
const DEADZONE = 0.24;

/**
 * Virtual analog stick. Drives `engine.touchMove`, which the engine prefers
 * whenever no movement key is held, so keyboard and touch can coexist.
 */
function Joystick({ engine }: { engine: GameEngine }) {
  const padRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState(false);

  // A match can restart or an overlay can unmount us mid-drag.
  useEffect(
    () => () => {
      engine.touchMove = null;
    },
    [engine],
  );

  const apply = (clientX: number, clientY: number) => {
    const el = padRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const radius = rect.width / 2;
    let dx = (clientX - (rect.left + radius)) / radius;
    let dy = (clientY - (rect.top + radius)) / radius;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) {
      dx /= mag;
      dy /= mag;
    }
    if (Math.hypot(dx, dy) < DEADZONE) {
      engine.touchMove = null;
      setKnob({ x: 0, y: 0 });
      return;
    }
    engine.touchMove = { x: dx, y: dy };
    setKnob({ x: dx * radius * KNOB_TRAVEL, y: dy * radius * KNOB_TRAVEL });
  };

  const release = () => {
    dragging.current = false;
    setActive(false);
    engine.touchMove = null;
    setKnob({ x: 0, y: 0 });
  };

  return (
    <div
      ref={padRef}
      role="button"
      aria-label="Virtual joystick — drag to move"
      className="pointer-events-auto relative h-24 w-24 touch-none select-none rounded-full border border-void-700 bg-void-950/70 sm:h-28 sm:w-28"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        dragging.current = true;
        setActive(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        apply(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (dragging.current) apply(e.clientX, e.clientY);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div
        className={cn(
          "absolute left-1/2 top-1/2 h-10 w-10 rounded-full border transition-colors",
          active
            ? "border-signal bg-signal/30"
            : "border-signal/50 bg-signal/15",
        )}
        style={{
          transform: `translate(-50%, -50%) translate(${knob.x}px, ${knob.y}px)`,
        }}
      />
      <span className="pointer-events-none absolute inset-x-0 bottom-1.5 text-center text-[8px] tracking-[0.2em] text-slate-600">
        MOVE
      </span>
    </div>
  );
}

function ActionButton({
  onDown,
  onUp,
  disabled,
  className,
  label,
  children,
}: {
  onDown: () => void;
  onUp?: () => void;
  disabled?: boolean;
  className?: string;
  label: string;
  children: ReactNode;
}) {
  const down = (e: React.PointerEvent) => {
    if (disabled) return;
    // Suppress the synthetic mouse click that follows on touch.
    e.preventDefault();
    onDown();
  };
  const up = () => {
    if (disabled) return;
    onUp?.();
  };

  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onPointerDown={down}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={up}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onDown();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") onUp?.();
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        "pointer-events-auto flex touch-none select-none items-center justify-center gap-1 rounded-xl border px-2 text-[9px] font-bold tracking-[0.15em] transition active:scale-95 disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * Thumb controls for phones/tablets: a joystick bottom-left and contextual
 * action buttons bottom-right (interact/report for crew, plus kill/sabotage
 * for the imposter). Rendered by GameStage only on compact layouts.
 */
export function TouchControls({ engine, snap, onAction }: TouchControlsProps) {
  const isImposter = snap.role === "imposter";

  // "E" must stay held while repairing a sabotage, exactly like the key does.
  const pressInteract = () => {
    engine.setKey("e", true);
    engine.interact();
    onAction();
  };
  const releaseInteract = () => {
    engine.setKey("e", false);
    onAction();
  };

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-end justify-between gap-3 p-3"
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}
    >
      <Joystick engine={engine} />

      <div className="grid grid-cols-2 gap-2">
        <ActionButton
          label="Interact"
          onDown={pressInteract}
          onUp={releaseInteract}
          className="col-span-2 h-11 border-signal/50 bg-signal/10 text-signal"
        >
          <Hand className="h-3.5 w-3.5" />
          USE
        </ActionButton>

        <ActionButton
          label="Report"
          onDown={() => {
            engine.report();
            onAction();
          }}
          className={cn(
            "h-11 border-void-700 bg-void-950/85 text-slate-300",
            !isImposter && "col-span-2",
          )}
        >
          <Megaphone className="h-3.5 w-3.5" />
          REPORT
        </ActionButton>

        {isImposter && (
          <>
            <ActionButton
              label="Kill"
              disabled={snap.killCooldown > 0}
              onDown={() => {
                engine.playerKill();
                onAction();
              }}
              className="h-11 border-[#ff4d6a]/60 bg-[#ff4d6a]/15 text-[#ff8a9c]"
            >
              <Skull className="h-3.5 w-3.5" />
              {snap.killCooldown > 0 ? `${Math.ceil(snap.killCooldown)}s` : "KILL"}
            </ActionButton>
            <ActionButton
              label="Sabotage"
              disabled={Boolean(snap.sabotage) || snap.sabotageCooldown > 0}
              onDown={() => {
                engine.triggerSabotage();
                onAction();
              }}
              className="col-span-2 h-11 border-hazard/50 bg-hazard/10 text-hazard"
            >
              <Zap className="h-3.5 w-3.5" />
              {snap.sabotageCooldown > 0
                ? `${Math.ceil(snap.sabotageCooldown)}s`
                : "SAB"}
            </ActionButton>
          </>
        )}
      </div>
    </div>
  );
}
