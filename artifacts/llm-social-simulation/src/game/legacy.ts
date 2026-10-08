/**
 * Cross-match memory: the ledger of grudges and reputations that carries
 * between shifts.
 *
 * Every other persistence layer in this game is about a single match. This one
 * exists because the thing that makes a cast of AI agents worth watching is not
 * any one round — it is that they remember the last one. An agent that was
 * voted out takes a grudge against everyone who voted for it, and opens the
 * next match already watching them. The bias is capped (`MAX_GRUDGE`), so the
 * grudge shades a choice without ever deciding it.
 *
 * Identity across matches is the agent's **model** — the name it runs on (or
 * `AI-1…` in pure heuristic mode), which is exactly the label the audience
 * tracks. Seat labels like "Minimax M3-2" are display-only: the engine folds
 * and reads the ledger by the model behind the seat, so a shift where a
 * *different* model draws the twin seat does not invent a new agent. Like
 * `persistence.ts`, every storage access is wrapped: a disabled or full
 * `localStorage` degrades this to no-op rather than breaking a match.
 */

import { seedDistrust, type Mind } from "./perception";

const STORAGE_KEY = "umbra.legacy.v1";
/** How much one betrayed vote is worth when it becomes a grudge. */
const GRUDGE_PER_VOTE = 1;
/** Grudges thin out between shifts, so an old debt eventually fades. */
const GRUDGE_DECAY = 0.75;

export interface LegacyAgent {
  name: string;
  /** Shifts this agent has played. */
  games: number;
  /** Shifts its faction won. */
  wins: number;
  /** Times it was voted out. */
  eliminations: number;
  /** Times it was voted out and turned out innocent. */
  mislynched: number;
  /** name -> grudge intensity, built from being voted out. */
  grudges: Record<string, number>;
}

export interface LegacyLedger {
  /** Total shifts recorded. */
  shifts: number;
  agents: Record<string, LegacyAgent>;
}

export interface LegacyEjection {
  /** Name of the agent that was voted out. */
  name: string;
  role: "crew" | "imposter";
  /** Names of everyone who voted for them. */
  voters: string[];
}

/** The end-of-match facts `foldMatch` needs. Kept structural, not engine-typed. */
export interface LegacyMatchSummary {
  winner: "crew" | "imposter";
  roster: { name: string; role: "crew" | "imposter" }[];
  ejections: LegacyEjection[];
}

export function emptyLedger(): LegacyLedger {
  return { shifts: 0, agents: {} };
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function loadLegacy(): LegacyLedger {
  const s = storage();
  if (!s) return emptyLedger();
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return emptyLedger();
    const parsed = JSON.parse(raw) as LegacyLedger;
    if (!parsed || typeof parsed !== "object" || typeof parsed.agents !== "object") {
      return emptyLedger();
    }
    // Tolerate a partial record: an old ledger may predate a field.
    const agents: Record<string, LegacyAgent> = {};
    for (const [name, a] of Object.entries(parsed.agents ?? {})) {
      agents[name] = {
        name,
        games: a?.games ?? 0,
        wins: a?.wins ?? 0,
        eliminations: a?.eliminations ?? 0,
        mislynched: a?.mislynched ?? 0,
        grudges: a?.grudges && typeof a.grudges === "object" ? a.grudges : {},
      };
    }
    return { shifts: parsed.shifts ?? 0, agents };
  } catch {
    return emptyLedger();
  }
}

export function saveLegacy(ledger: LegacyLedger): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(ledger));
  } catch {
    // Storage full or blocked — the ledger is a nice-to-have, never fatal.
  }
}

export function clearLegacy(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function ensure(ledger: LegacyLedger, name: string): LegacyAgent {
  let agent = ledger.agents[name];
  if (!agent) {
    agent = { name, games: 0, wins: 0, eliminations: 0, mislynched: 0, grudges: {} };
    ledger.agents[name] = agent;
  }
  return agent;
}

/**
 * Fold one finished match into the ledger. Pure — takes the ledger and returns
 * the next one, so it can be exercised headlessly without any storage.
 *
 * The one rule that matters: an **innocent** agent that gets voted out blames
 * every voter. An impostor that gets caught has nothing to hold against anyone,
 * so a correct ejection leaves no grudge behind.
 */
export function foldMatch(ledger: LegacyLedger, summary: LegacyMatchSummary): LegacyLedger {
  const next: LegacyLedger = {
    shifts: ledger.shifts + 1,
    agents: Object.fromEntries(
      Object.entries(ledger.agents).map(([name, a]) => [
        name,
        { ...a, grudges: { ...a.grudges } },
      ]),
    ),
  };

  const counted = new Set<string>();
  for (const row of summary.roster) {
    // Two seats can run the same model in one shift (the pool can be smaller
    // than the deck); the summary lists both, but one agent plays one shift —
    // count each identity + faction once so a twin seat cannot double wins.
    const countedKey = `${row.name}\u0000${row.role}`;
    if (counted.has(countedKey)) continue;
    counted.add(countedKey);
    const agent = ensure(next, row.name);
    agent.games++;
    const onWinningSide =
      (summary.winner === "crew" && row.role === "crew") ||
      (summary.winner === "imposter" && row.role === "imposter");
    if (onWinningSide) agent.wins++;
  }

  for (const ejection of summary.ejections) {
    const victim = ensure(next, ejection.name);
    victim.eliminations++;
    if (ejection.role === "crew") victim.mislynched++;
    if (ejection.role !== "crew") continue;
    for (const voter of ejection.voters) {
      if (voter === ejection.name) continue;
      victim.grudges[voter] = (victim.grudges[voter] ?? 0) + GRUDGE_PER_VOTE;
    }
  }

  // Thin every grudge once per shift, dropping the ones that have faded out.
  for (const agent of Object.values(next.agents)) {
    const kept: Record<string, number> = {};
    for (const [name, weight] of Object.entries(agent.grudges)) {
      const w = weight * GRUDGE_DECAY;
      if (w * GRUDGE_PER_VOTE >= 0.5) kept[name] = w;
    }
    agent.grudges = kept;
  }

  return next;
}

/** How much an agent distrusts `target` at the start of a shift, 0..MAX_GRUDGE. */
export function grudgeWeight(ledger: LegacyLedger, name: string, target: string): number {
  const weight = ledger.agents[name]?.grudges[target] ?? 0;
  // One betrayed vote is worth ~0.045 of opening bias; two is worth ~0.08.
  return Math.min(0.12, weight * 0.045);
}

/**
 * Seed one agent's opening beliefs from the ledger. Called once at roster build,
 * before anyone has seen anything, so a grudge is something the agent *brought
 * with it* rather than something the match told it.
 *
 * Returns the names that actually landed. A target the belief model then
 * refuses — a traitor's own partner — is not reported as applied.
 */
export function seedGrudges(
  mind: Mind,
  name: string,
  ledger: LegacyLedger,
  roster: { key: string; name: string }[],
): string[] {
  const applied: string[] = [];
  for (const other of roster) {
    if (other.key === mind.key) continue;
    const weight = grudgeWeight(ledger, name, other.name);
    if (weight <= 0) continue;
    if (seedDistrust(mind, other.key, weight)) applied.push(other.name);
  }
  return applied;
}

/** The grudges a named agent carries, strongest first — for the briefing UI. */
export function grudgesFor(ledger: LegacyLedger, name: string): string[] {
  const grudges = ledger.agents[name]?.grudges ?? {};
  return Object.entries(grudges)
    .sort((a, b) => b[1] - a[1])
    .map(([target]) => target);
}

export function describeLegacy(ledger: LegacyLedger): string {
  if (ledger.shifts === 0) return "No prior shifts on record.";
  const agents = Object.keys(ledger.agents).length;
  return `${ledger.shifts} prior shift${ledger.shifts === 1 ? "" : "s"} · ${agents} agents on record`;
}
