import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { ChatMessage, MeetingView, SpeakerView } from "@/game/engine";
import { cn } from "@/lib/utils";

interface MeetingOverlayProps {
  meeting: MeetingView;
  /** Spectators watch the meeting read-only: no speech, no vote, no skip. */
  spectator?: boolean;
  onSay: (text: string) => void;
  onVote: (key: string | null) => void;
  onAdvance: () => void;
}

function Timer({ seconds, danger }: { seconds: number; danger?: boolean }) {
  return (
    <span
      className={cn(
        "font-mono text-sm tabular-nums",
        danger ? "text-hazard" : "text-signal",
      )}
    >
      {String(Math.floor(seconds / 60)).padStart(2, "0")}:
      {String(seconds % 60).padStart(2, "0")}
    </span>
  );
}

function ChatLog({ messages }: { messages: ChatMessage[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll only the log itself. `scrollIntoView` would also scroll the page,
    // which on mobile drags the stage off screen the moment a meeting opens.
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [messages.length]);

  return (
    <div
      ref={boxRef}
      className="h-40 space-y-2 overflow-y-auto rounded-lg border border-void-700 bg-void-950/70 p-3 sm:h-56"
    >
      {messages.length === 0 && (
        <p className="text-xs text-slate-600">The room is quiet…</p>
      )}
      {messages.map((m) => (
        <div key={m.id} className="text-xs leading-relaxed">
          {m.kind === "system" ? (
            <span className="text-hazard">— {m.text}</span>
          ) : (
            <>
              <span
                className="font-semibold"
                style={{ color: m.color }}
              >
                {m.speakerName}
                {m.kind === "player" ? " (you)" : ""}:
              </span>{" "}
              <span className="text-slate-300">{m.text}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function VoteCard({
  speaker,
  revealed,
  voteLabel,
  myVote,
  selectable,
  onSelect,
}: {
  speaker: SpeakerView;
  revealed: boolean;
  voteLabel: string | null;
  myVote: string | null;
  selectable: boolean;
  onSelect: () => void;
}) {
  const isMine = speaker.isPlayer;
  const selected = myVote === speaker.key;

  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition",
        selected
          ? "border-signal bg-signal/10"
          : "border-void-700 bg-void-900/60 hover:border-slate-500",
        !selectable && "cursor-default opacity-80",
        !speaker.alive && "opacity-40",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          className="h-3 w-3 rounded-full"
          style={{ backgroundColor: speaker.color }}
        />
        <span className="text-xs font-semibold text-slate-200">
          {speaker.name}
          {isMine ? " (you)" : ""}
        </span>
      </span>
      <span className="text-[10px] tracking-widest text-slate-500">
        {revealed ? (
          voteLabel ? (
            <span className="text-hazard">→ {voteLabel}</span>
          ) : (
            <span className="text-slate-600">SKIP</span>
          )
        ) : selected ? (
          <span className="text-signal">SELECTED</span>
        ) : speaker.voted ? (
          <span className="text-signal">VOTED</span>
        ) : (
          "…"
        )}
      </span>
    </button>
  );
}

export function MeetingOverlay({
  meeting,
  spectator = false,
  onSay,
  onVote,
  onAdvance,
}: MeetingOverlayProps) {
  const [draft, setDraft] = useState("");
  const canSpeak = meeting.stage === "discussion" && !spectator;
  const canVote = meeting.stage === "voting" && !spectator;

  const send = () => {
    if (!draft.trim()) return;
    onSay(draft);
    setDraft("");
  };

  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center overflow-y-auto bg-void-950/90 px-3 py-4 sm:px-4 sm:py-6">
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="my-auto flex w-full max-w-3xl flex-col gap-3 sm:gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hazard/40 bg-hazard/10 px-3 py-2.5 sm:px-4 sm:py-3">
          <div>
            <p className="text-[11px] tracking-[0.25em] text-hazard">
              {meeting.reason.toUpperCase()}
            </p>
            <p className="font-display text-lg font-bold text-slate-100">
              {meeting.stage === "discussion"
                ? "Discussion"
                : meeting.stage === "voting"
                  ? "Voting"
                  : "Result"}
            </p>
          </div>
          <div className="flex items-center gap-3 sm:gap-4">
            <Timer seconds={meeting.secondsLeft} danger={meeting.stage !== "tally"} />
            {canSpeak && (
              <button
                type="button"
                onClick={onAdvance}
                className="rounded-lg border border-void-700 bg-void-900 px-3 py-1.5 text-[11px] tracking-widest text-slate-300 transition hover:bg-void-800"
              >
                MOVE TO VOTE
              </button>
            )}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 sm:gap-4">
          <div className="space-y-3">
            <ChatLog messages={meeting.messages} />
            {canSpeak && (
              <div className="flex gap-2">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      send();
                    }
                    e.stopPropagation();
                  }}
                  maxLength={200}
                  placeholder="Say what you saw…"
                  className="flex-1 rounded-lg border border-void-700 bg-void-950 px-3 py-2 text-xs text-slate-200 outline-none focus:border-signal"
                />
                <button
                  type="button"
                  onClick={send}
                  className="rounded-lg bg-signal px-3 py-2 text-xs font-semibold text-void-950 transition hover:bg-signal/90"
                >
                  SAY
                </button>
              </div>
            )}
            {canVote && (
              <p className="text-[11px] leading-relaxed text-slate-500">
                Your vote comes from your own suspicion — pick who you trust least.
              </p>
            )}
            {spectator && (meeting.stage === "discussion" || meeting.stage === "voting") && (
              <p className="text-[11px] leading-relaxed text-[#c4b5fd]/80">
                You are spectating — the agents run this meeting on their own.
              </p>
            )}
          </div>

          <div className="space-y-2">
            {meeting.stage === "tally" ? (
              <div className="rounded-xl border border-void-700 bg-void-900/60 p-4">
                <p className="text-[11px] tracking-[0.25em] text-slate-500">EJECTED</p>
                {meeting.ejection ? (
                  <>
                    <p className="mt-2 font-display text-2xl font-black text-white">
                      {meeting.ejection.name}
                    </p>
                    <p
                      className={cn(
                        "mt-1 text-sm",
                        meeting.ejection.isImposter ? "text-signal" : "text-hazard",
                      )}
                    >
                      {meeting.ejection.isImposter
                        ? "was an imposter."
                        : "was innocent."}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-slate-400">
                    Nobody was ejected — the room couldn't agree.
                  </p>
                )}
              </div>
            ) : (
              <>
                <p className="text-[11px] tracking-[0.25em] text-slate-500">
                  {canVote ? "CAST YOUR VOTE" : "SUSPECTS"}
                </p>
                {meeting.speakers.map((s) => (
                  <VoteCard
                    key={s.key}
                    speaker={s}
                    revealed={meeting.votesRevealed}
                    voteLabel={
                      meeting.revealedVotes.find((v) => v.key === s.key)?.targetName ?? null
                    }
                    myVote={meeting.myVote}
                    selectable={canVote}
                    onSelect={() => onVote(s.key)}
                  />
                ))}
                {canVote && (
                  <button
                    type="button"
                    onClick={() => onVote(null)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left text-xs transition",
                      meeting.myVote === null
                        ? "border-signal bg-signal/10 text-signal"
                        : "border-void-700 bg-void-900/60 text-slate-400 hover:border-slate-500",
                    )}
                  >
                    SKIP VOTE
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
