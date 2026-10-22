import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type MinigameKind = "wiring" | "calibration";

interface TaskModalProps {
  label: string;
  room: string;
  kind: MinigameKind;
  onComplete: () => void;
  onFail: () => void;
}

const WIRE_COLORS = ["#38e1c8", "#ffb020", "#ef4444", "#a855f7"];
const ROUND_SECONDS = 45;

function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed | 0 || 7;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) | 0;
    const j = Math.abs(s) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Connect each terminal on the left to its colour-matched partner on the right. */
function Wiring({ seed, onDone }: { seed: number; onDone: () => void }) {
  const rightOrder = useRef(shuffle(WIRE_COLORS, seed)).current;
  const [selected, setSelected] = useState<string | null>(null);
  const [linked, setLinked] = useState<string[]>([]);
  const [error, setError] = useState(false);

  const click = (color: string) => {
    if (linked.includes(color)) return;
    if (!selected) {
      setSelected(color);
      return;
    }
    if (selected === color) {
      const next = [...linked, color];
      setLinked(next);
      setSelected(null);
      setError(false);
      if (next.length === WIRE_COLORS.length) onDone();
    } else {
      setError(true);
      setSelected(null);
      window.setTimeout(() => setError(false), 350);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 sm:gap-6">
      <div className="flex flex-col gap-3">
        {WIRE_COLORS.map((c) => (
          <button
            key={`l-${c}`}
            type="button"
            onClick={() => click(c)}
            disabled={linked.includes(c)}
            aria-label={`left terminal ${c}`}
            className={cn(
              "h-11 w-11 rounded-md border-2 transition sm:h-9 sm:w-9",
              linked.includes(c) && "opacity-30",
              selected === c && "scale-110 ring-2 ring-white/60",
            )}
            style={{ backgroundColor: c, borderColor: "#0b1220" }}
          />
        ))}
      </div>

      <div className="flex-1 text-center text-[11px] tracking-widest text-slate-500">
        {error ? (
          <span className="text-hazard">MISMATCH — TRACE BROKEN</span>
        ) : linked.length === WIRE_COLORS.length ? (
          <span className="text-signal">CIRCUIT CLOSED</span>
        ) : (
          <>PAIR THE COLOURS · {linked.length}/{WIRE_COLORS.length}</>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {rightOrder.map((c) => (
          <button
            key={`r-${c}`}
            type="button"
            onClick={() => click(c)}
            disabled={linked.includes(c)}
            aria-label={`right terminal ${c}`}
            className={cn(
              "h-11 w-11 rounded-md border-2 transition sm:h-9 sm:w-9",
              linked.includes(c) && "opacity-30",
              error && "animate-pulse",
            )}
            style={{ backgroundColor: c, borderColor: "#0b1220" }}
          />
        ))}
      </div>
    </div>
  );
}

/** Lock the sweeping marker inside the green band three times. */
function Calibration({ onDone }: { onDone: () => void }) {
  const [pos, setPos] = useState(0);
  const [zone] = useState(() => 20 + Math.random() * 55);
  const [hits, setHits] = useState(0);
  const [flash, setFlash] = useState<"none" | "hit" | "miss">("none");
  const dir = useRef(1);
  const raf = useRef(0);

  useEffect(() => {
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      setPos((p) => {
        let next = p + dir.current * dt * 78;
        if (next >= 100) {
          next = 100;
          dir.current = -1;
        }
        if (next <= 0) {
          next = 0;
          dir.current = 1;
        }
        return next;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  const lock = () => {
    const inside = pos >= zone && pos <= zone + 16;
    if (inside) {
      const next = hits + 1;
      setHits(next);
      setFlash("hit");
      if (next >= 3) {
        window.setTimeout(onDone, 180);
        return;
      }
    } else {
      setFlash("miss");
    }
    window.setTimeout(() => setFlash("none"), 220);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === "Enter") {
        e.preventDefault();
        lock();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="space-y-4">
      <div className="relative h-14 w-full overflow-hidden rounded-lg border border-void-700 bg-void-950">
        <div
          className="absolute inset-y-0 border-x-2 border-signal/70 bg-signal/20"
          style={{ left: `${zone}%`, width: "16%" }}
        />
        <div
          className={cn(
            "absolute inset-y-1 w-1.5 rounded-full",
            flash === "hit" && "bg-signal",
            flash === "miss" && "bg-hazard",
            flash === "none" && "bg-white",
          )}
          style={{ left: `calc(${pos}% - 3px)` }}
        />
      </div>
      <div className="flex items-center justify-between text-[11px] tracking-widest text-slate-500">
        <span>ALIGN THE SWEEP · LOCK INSIDE THE BAND</span>
        <span className="text-signal">{hits}/3</span>
      </div>
      <button
        type="button"
        onClick={lock}
        className="w-full rounded-lg bg-signal px-4 py-2.5 text-sm font-semibold text-void-950 transition hover:bg-signal/90"
      >
        LOCK (SPACE)
      </button>
    </div>
  );
}

function AsciiIdentify({ seed, onDone }: { seed: number; onDone: () => void }) {
  const glyphs = ["/\\", "|_|", "[_]", "<>", "#", "{}"];
  const target = glyphs[Math.abs(seed) % glyphs.length];
  const options = shuffle(glyphs, seed + 17);
  const [attempts, setAttempts] = useState(0);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-void-700 bg-void-950 p-5 text-center">
        <p className="mb-2 text-[10px] tracking-widest text-slate-500">IDENTIFY THE SIGNAL</p>
        <pre className="font-mono text-3xl font-bold text-signal">{target}</pre>
      </div>
      <p className="text-center text-xs text-slate-500">Which ASCII character sequence matches the signal?</p>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => (option === target ? onDone() : setAttempts((value) => value + 1))}
            className="rounded-lg border border-void-700 bg-void-950 px-3 py-3 font-mono text-lg text-slate-200 transition hover:border-signal hover:text-signal"
          >
            {option}
          </button>
        ))}
      </div>
      <p className="text-center text-[10px] tracking-widest text-slate-600">DECODE ATTEMPTS: {attempts}</p>
    </div>
  );
}

function Captcha({ seed, onDone }: { seed: number; onDone: () => void }) {
  const prompts = ["select every square with a signal", "click the squares in order", "verify the marked console"];
  const prompt = prompts[Math.abs(seed) % prompts.length];
  const correct = new Set([0, 3, 5]);
  const [selected, setSelected] = useState<number[]>([]);
  const submit = () => {
    if (selected.length === correct.size && selected.every((index) => correct.has(index))) onDone();
  };

  return (
    <div className="space-y-4">
      <p className="text-center text-xs uppercase tracking-widest text-slate-500">CAPTCHA: {prompt}</p>
      <div className="grid grid-cols-3 gap-2 rounded-lg border border-void-700 bg-void-950 p-2">
        {Array.from({ length: 6 }, (_, index) => (
          <button
            key={index}
            type="button"
            aria-pressed={selected.includes(index)}
            onClick={() => setSelected((current) => current.includes(index) ? current.filter((value) => value !== index) : [...current, index])}
            className={cn("aspect-square rounded-md border text-lg transition", selected.includes(index) ? "border-signal bg-signal/20 text-signal" : "border-void-700 bg-void-900 text-slate-600 hover:border-slate-400")}
          >
            {index % 2 === 0 ? "·" : "×"}
          </button>
        ))}
      </div>
      <button type="button" onClick={submit} className="w-full rounded-lg bg-signal px-4 py-2.5 text-sm font-semibold text-void-950 transition hover:bg-signal/90">VERIFY SELECTION</button>
    </div>
  );
}

function DrawAscii({ seed, onDone }: { seed: number; onDone: () => void }) {
  const target = ["X", "+", "O"][Math.abs(seed) % 3];
  const [cells, setCells] = useState<number[]>([]);
  const required = target === "X" ? [0, 4, 8, 2, 6] : target === "+" ? [1, 4, 3, 5, 7] : [1, 2, 5, 8, 7, 6, 3, 0];
  const draw = () => { if (required.every((cell) => cells.includes(cell))) onDone(); };

  return (
    <div className="space-y-4">
      <p className="text-center text-xs uppercase tracking-widest text-slate-500">DRAW THE ASCII GLYPH: <span className="font-mono text-signal">{target}</span></p>
      <div className="mx-auto grid max-w-[180px] grid-cols-3 gap-1 rounded-lg border border-void-700 bg-void-950 p-2">
        {Array.from({ length: 9 }, (_, index) => (
          <button key={index} type="button" aria-label={`draw cell ${index + 1}`} onClick={() => setCells((current) => current.includes(index) ? current : [...current, index])} className={cn("aspect-square rounded border transition", cells.includes(index) ? "border-signal bg-signal text-void-950" : "border-void-700 bg-void-900 hover:border-slate-400")} />
        ))}
      </div>
      <button type="button" onClick={draw} className="w-full rounded-lg bg-signal px-4 py-2.5 text-sm font-semibold text-void-950 transition hover:bg-signal/90">SUBMIT GLYPH</button>
    </div>
  );
}

export function TaskModal({ label, room, kind, onComplete, onFail }: TaskModalProps) {
  const [seconds, setSeconds] = useState(ROUND_SECONDS);

  useEffect(() => {
    const id = window.setInterval(() => {
      setSeconds((s) => {
        if (s <= 1) {
          window.clearInterval(id);
          onFail();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [onFail]);

  const seed = label.length * 31 + room.length;

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center overflow-y-auto bg-void-950/85 px-3 py-4 sm:px-4 sm:py-6">
      <div className="my-auto w-full max-w-md rounded-xl border border-void-700 bg-void-900 p-4 shadow-2xl sm:p-6">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] tracking-[0.25em] text-hazard">CONSOLE</span>
          <span className="font-mono text-[11px] text-slate-500">
            {String(Math.floor(seconds / 60)).padStart(2, "0")}:
            {String(seconds % 60).padStart(2, "0")}
          </span>
        </div>
        <h3 className="font-display text-lg font-bold text-slate-100">{label}</h3>
        <p className="mb-5 text-xs text-slate-500">{room}</p>

        {kind === "wiring" ? (
          <Wiring seed={seed} onDone={onComplete} />
        ) : kind === "calibration" ? (
          <Calibration onDone={onComplete} />
        ) : kind === "ascii" ? (
          <AsciiIdentify seed={seed} onDone={onComplete} />
        ) : kind === "captcha" ? (
          <Captcha seed={seed} onDone={onComplete} />
        ) : (
          <DrawAscii seed={seed} onDone={onComplete} />
        )}

        <button
          type="button"
          onClick={onFail}
          className="mt-5 w-full rounded-lg border border-void-700 px-4 py-2 text-xs tracking-widest text-slate-500 transition hover:bg-void-800"
        >
          ABORT
        </button>
      </div>
    </div>
  );
}
