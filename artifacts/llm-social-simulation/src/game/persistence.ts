/**
 * Match history.
 *
 * Every finished match is written to `localStorage` together with the full
 * meeting transcript and a snapshot of each agent's suspicion vector — that is
 * the raw material for the "does deception actually work?" question this repo
 * exists to answer.
 *
 * Everything is wrapped: private-mode browsers, quota errors or a disabled
 * storage just make the feature a no-op rather than throwing during a match.
 */

export interface TranscriptLine {
  t: number;
  who: string;
  text: string;
}

export interface BeliefSnapshot {
  key: string;
  name: string;
  role: "crew" | "imposter";
  suspects: { name: string; score: number }[];
  observations: number;
}

export interface MatchRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  winner: "crew" | "imposter";
  playerRole: "crew" | "imposter";
  roster: { key: string; name: string; role: "crew" | "imposter"; alive: boolean }[];
  meetings: number;
  ejects: number;
  tasksComplete: number;
  tasksTotal: number;
  llm: { calls: number; fallbacks: number };
  transcript: TranscriptLine[];
  beliefs: BeliefSnapshot[];
  /**
   * The public station log the AI crew wrote at the generative consoles, and
   * the private thoughts behind every decision and meeting line. Both are
   * optional: matches recorded before the watchability pass do not have them.
   */
  stationLog?: { t: number; name: string; text: string; source: string }[];
  confessional?: {
    t: number;
    name: string;
    role: "crew" | "imposter";
    action: string;
    thought: string;
  }[];
}

const STORAGE_KEY = "umbra.match-history.v1";
const MAX_RECORDS = 12;

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function loadMatches(): MatchRecord[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as MatchRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMatch(record: MatchRecord): MatchRecord[] {
  const s = storage();
  const next = [record, ...loadMatches().filter((m) => m.id !== record.id)].slice(0, MAX_RECORDS);
  if (!s) return next;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked — history is a nice-to-have, never fatal.
  }
  return next;
}

export function clearMatches(): MatchRecord[] {
  const s = storage();
  try {
    s?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return [];
}

/** Short human label for a match, used in the history list. */
export function describeMatch(m: MatchRecord): string {
  const mins = Math.floor(m.durationSec / 60);
  const secs = Math.round(m.durationSec % 60);
  const verdict = m.winner === "crew" ? "Crew victory" : "Imposter victory";
  return `${verdict} · ${m.meetings} meeting${m.meetings === 1 ? "" : "s"} · ${mins}:${String(secs).padStart(2, "0")}`;
}
