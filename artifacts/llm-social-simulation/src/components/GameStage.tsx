import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UMBRA_DECK_MAP } from "@/game/map";
import type { Snapshot } from "@/game/engine";
import {
  LocalGameLink,
  type GameLink,
  type LinkStatus,
} from "@/game/link";
import { RemoteGameLink } from "@/game/remoteLink";
import type { MatchRecord } from "@/game/persistence";
import { drawMap } from "@/game/render/renderMap";
import { useIsMobile } from "@/hooks/use-mobile";
import { Confessional } from "./Confessional";
import { Broadcast } from "./Broadcast";
import { GameHud } from "./GameHud";
import { Briefing, EndScreen, type RosterRow } from "./GameOverlays";
import { MeetingOverlay } from "./MeetingOverlay";
import { clearSpeech, loadVoiceEnabled, saveVoiceEnabled, speakLine } from "./voice";
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

/**
 * Hosts the canvas, the match link and every overlay.
 *
 * The stage never touches a `GameEngine` itself: it drives a `GameLink`,
 * which is either the in-page engine (offline fallback and the synchronous
 * first render) or `RemoteGameLink`, the autonomous station host. React
 * renders a 10 Hz snapshot either way, and the canvas draws one interpolated
 * frame per rAF — so a hosted match watched over SSE looks identical to a
 * local one, and closing the tab merely pauses the viewer, not the match.
 */
export function GameStage({ className, history, onHistoryChange }: GameStageProps) {
  const [link, setLink] = useState<GameLink>(() => new LocalGameLink());
  const [snap, setSnap] = useState<Snapshot>(() => link.snapshot());
  const [analyst, setAnalyst] = useState(false);
  /** Manual override for the confessional gate; see `Confessional`. */
  const [confessionalOpen, setConfessionalOpen] = useState(false);
  /** Uplink state: connecting → live (hosted) or offline (local fallback). */
  const [conn, setConn] = useState<LinkStatus>("local");
  /** True once a hosted match has been adopted, to phrase the offline badge. */
  const [hosted, setHosted] = useState(false);
  /** The cast's TTS voices — public lines only; see `voice.ts`. */
  const [voice, setVoice] = useState(() => loadVoiceEnabled());
  const isMobile = useIsMobile();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLImageElement | null>(null);

  // Keep the newest history callback without re-dialling the host for it.
  const historyRef = useRef(onHistoryChange);
  historyRef.current = onHistoryChange;

  const roster: RosterRow[] = useMemo(() => link.roster(), [link, snap.phase]);

  const sync = useCallback(() => setSnap(link.snapshot()), [link]);

  // The confessional is a spoiler by construction — a traitor is candid in it
  // and the crew never hears it. So it is only legible once you are no longer
  // one of the players: while spectating, after the verdict, or if you ask.
  const confessionalReveal =
    snap.spectator || snap.phase === "ended" || confessionalOpen;

  // --- the uplink ----------------------------------------------------------
  // Dial the station host on mount. While it answers, the match runs there:
  // it keeps ticking with the tab closed, and reconnecting re-attaches to the
  // same shift (the session id in localStorage is what claims the seat back).
  // No host within five seconds — a static build — and the local engine from
  // the first render simply keeps playing.
  useEffect(() => {
    const remote = new RemoteGameLink();
    remote.handlers = {
      onHistory: (records) => historyRef.current?.(records),
    };
    remote.onStatus = (status) => {
      setConn(status);
      if (status === "live") {
        setHosted(true);
        setLink((current) => (current.mode === "remote" ? current : remote));
      }
    };
    remote.connect();
    return () => {
      remote.onStatus = null;
      remote.dispose();
    };
  }, []);

  // Hand whichever link is current the stage's history callback, so a
  // finished match (local save or server push) lands in the App's list.
  useEffect(() => {
    link.handlers = { onHistory: onHistoryChange };
    return () => {
      link.handlers = {};
    };
  }, [link, onHistoryChange]);

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

    let raf = 0;
    const frame = (now: number) => {
      // One call advances the view (a local link ticks its engine here; the
      // remote link interpolates the latest server frames) and returns what
      // to draw.
      const scene = link.frame(now);
      drawMap(ctx, UMBRA_DECK_MAP, cssW, cssH, dpr, {
        biasY,
        background: bg.complete && bg.naturalWidth > 0 ? bg : null,
        ...scene,
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
      bgRef.current = null;
    };
  }, [link, sync]);

  // --- keyboard ------------------------------------------------------------
  // There is no keyboard to play with: the stage is a viewer. The engine
  // still accepts input (the headless checks drive it directly), but nothing
  // in this UI hands the human body a control anymore.

  const restart = () => {
    // Local: a fresh engine re-reads the ledger, so the grudges this match
    // just banked are already in the next roster's heads. Remote: the host
    // builds the next shift server-side and the next state frame shows its
    // briefing. Either way the traitors are re-drawn at random.
    link.restart();
    setSnap(link.snapshot());
    setAnalyst(link.analyst);
    setConfessionalOpen(false);
  };

  // --- voices -------------------------------------------------------------
  // Public lines only: meeting statements, the ejection verdict, the verdict.
  // The gate re-anchors whenever it changes so toggling never speaks a backlog.
  const voiceState = useRef({
    inited: false,
    msgs: 0,
    stage: null as string | null,
    phase: snap.phase,
  });

  useEffect(() => {
    voiceState.current.inited = false;
    if (!voice) clearSpeech();
  }, [voice]);

  useEffect(() => {
    const v = voiceState.current;
    const meeting = snap.meeting;
    const msgs = meeting?.messages.length ?? 0;
    const stage = meeting?.stage ?? null;

    if (!voice) {
      v.msgs = msgs;
      v.stage = stage;
      v.phase = snap.phase;
      return;
    }
    if (!v.inited) {
      // First frame after an enable or a rejoin: anchor, never read history.
      v.inited = true;
      v.msgs = msgs;
      v.stage = stage;
      v.phase = snap.phase;
      return;
    }

    if (meeting && msgs > v.msgs) {
      for (const m of meeting.messages.slice(v.msgs)) {
        // System lines are stage direction; the player's own text is theirs.
        if (m.kind === "system" || m.kind === "player") continue;
        speakLine(m.text, m.speakerKey);
      }
    }
    if (stage === "tally" && v.stage !== "tally") {
      clearSpeech();
      const e = meeting?.ejection;
      speakLine(
        e
          ? `${e.name} ${e.isImposter ? "was an impostor" : "was innocent"}`
          : "No one was ejected.",
        "verdict",
      );
    }
    if (snap.phase === "ended" && v.phase !== "ended" && snap.winner) {
      clearSpeech();
      speakLine(
        snap.winner === "crew" ? "Crew victory." : "Imposter victory.",
        "victory",
      );
    }

    v.msgs = msgs;
    v.stage = stage;
    v.phase = snap.phase;
  }, [snap, voice]);

  const uplink =
    conn === "live"
      ? hosted
        ? "STATION LIVE — the shift keeps running while your tab is closed"
        : "CONNECTED"
      : conn === "connecting"
        ? "DIALING THE STATION…"
        : conn === "offline"
          ? hosted
            ? "UPLINK LOST — retrying…"
            : "HOST OFFLINE — playing this shift locally (no rejoin)"
          : null;

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

            {/* First paint races the host: veil the stage until the uplink
                answers (or falls back) so a local roster never flashes over a
                hosted mid-shift join. */}
            {conn === "connecting" && (
              <div className="absolute inset-x-0 top-0 z-30 flex justify-center rounded-t-xl bg-void-950/70 py-2">
                <span className="font-display text-[10px] tracking-[0.3em] text-slate-500">
                  ESTABLISHING UPLINK…
                </span>
              </div>
            )}

            <GameHud
              snap={snap}
              compact={isMobile}
              analyst={analyst}
              voice={voice}
              onToggleVoice={() => setVoice((on) => {
                const next = !on;
                saveVoiceEnabled(next);
                return next;
              })}
              onToggleAnalyst={() => {
                link.analyst = !link.analyst;
                setAnalyst(link.analyst);
                sync();
              }}
              spectator={snap.spectator}
            />
          </div>
        </div>

        {snap.phase === "briefing" && (
          <Briefing
            roster={roster}
            legacy={snap.legacy}
            compact={isMobile}
            onWatch={() => {
              // Every shift is watched, never played: straight into spectator
              // mode, full deck vision, the AI cast on its own.
              link.begin(true);
              sync();
            }}
          />
        )}

        {snap.meeting && (
          <MeetingOverlay
            meeting={snap.meeting}
            spectator={snap.spectator}
            onSay={(text) => {
              link.say(text);
              sync();
            }}
            onVote={(key) => {
              link.vote(key);
              sync();
            }}
            onAdvance={() => {
              link.advanceMeeting();
              sync();
            }}
          />
        )}

        {snap.phase === "ended" && (
          <EndScreen snap={snap} history={history ?? []} onRestart={restart} />
        )}

        {/* The produced show: slams, the ejection screen, the audience-only
            reveal and the live ticker — all read from the event timeline. */}
        <Broadcast snap={snap} roster={roster} compact={isMobile} />
      </div>

      {/* One line about where the match is running — the whole reason a
          closed tab is safe. Seeded viewers also see when someone else holds
          the crew seat. */}
      {(uplink || (link.seat === "spectator" && !snap.spectator)) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] tracking-[0.2em] text-slate-500">
          {uplink && (
            <span className={cn(conn === "live" ? "text-signal" : "text-slate-500")}>
              <span
                className={cn(
                  "mr-2 inline-block h-1.5 w-1.5 rounded-full align-middle",
                  conn === "live" ? "bg-signal" : "bg-slate-600",
                )}
              />
              {uplink}
            </span>
          )}
          {link.seat === "spectator" && !snap.spectator && (
            <span>ANOTHER VIEWER HOLDS THE CREW SEAT — YOU ARE WATCHING</span>
          )}
        </div>
      )}

      {/* The confessional read-out lives in normal flow below the deck (and
          below the meeting/end overlays), so it never fights the HUD for map
          space. */}
      <div className="mt-3">
        <Confessional
          entries={snap.confessional}
          reveal={confessionalReveal}
          onReveal={() => setConfessionalOpen(true)}
          compact={isMobile}
        />
      </div>
    </div>
  );
}
