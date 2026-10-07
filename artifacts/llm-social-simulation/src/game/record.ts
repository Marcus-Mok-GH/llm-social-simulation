/**
 * The finished-match record.
 *
 * Extracted from the end screen wiring so the same record can be written from
 * either side of the wire: a browser-local match folds it into `localStorage`,
 * and the autonomous match host folds it into the shared server-side history
 * when a shift ends with nobody watching.
 */

import type { GameEngine } from "./engine";
import { rankSuspects } from "./perception";
import type { MatchRecord } from "./persistence";

export function buildMatchRecord(
  engine: GameEngine,
  winner: "crew" | "imposter",
): MatchRecord {
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
    stationLog: engine.stationLog.map((e) => ({
      t: e.t,
      name: e.name,
      text: e.text,
      source: e.source,
    })),
    // The structured timeline the recap reads: who killed whom, who was voted
    // out and why, and the verdict — facts, not prose.
    events: engine.matchEvents(),
    confessional: engine.confessional.map((c) => ({
      t: c.t,
      name: c.name,
      role: c.role,
      action: c.action,
      thought: c.thought,
    })),
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
