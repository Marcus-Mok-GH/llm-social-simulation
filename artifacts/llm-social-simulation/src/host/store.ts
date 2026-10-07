/**
 * Server-side persistence for the two things that must outlive a process:
 *
 *  - the cross-match **ledger** the agents learn from (wins, eliminations,
 *    grudges), and
 *  - the shared **match history** every viewer reads.
 *
 * Both are tiny JSON files under `.data/` next to the artifact. Every access
 * is wrapped and falls back to memory, exactly like the browser-side stores —
 * a missing or unwritable directory degrades the feature, never the match.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyLedger, type LegacyLedger } from "../game/legacy";
import type { MatchRecord } from "../game/persistence";

export interface HostStore {
  loadLedger(): LegacyLedger;
  saveLedger(ledger: LegacyLedger): void;
  loadHistory(): MatchRecord[];
  saveHistory(history: MatchRecord[]): void;
}

function isLedger(value: unknown): value is LegacyLedger {
  const l = value as LegacyLedger | null;
  return Boolean(l && typeof l === "object" && l.agents && typeof l.agents === "object");
}

/** In-memory store for tests and for a host that cannot touch the disk. */
export function createMemoryStore(seed?: {
  ledger?: LegacyLedger;
  history?: MatchRecord[];
}): HostStore {
  let ledger = seed?.ledger ?? emptyLedger();
  let history = seed?.history ?? [];
  return {
    loadLedger: () => ledger,
    saveLedger: (next) => {
      ledger = next;
    },
    loadHistory: () => history,
    saveHistory: (next) => {
      history = next;
    },
  };
}

export function createFileStore(dir: string): HostStore {
  const ledgerFile = join(dir, "ledger.json");
  const historyFile = join(dir, "matches.json");

  const readJson = <T>(file: string, fallback: T, check: (v: unknown) => boolean): T => {
    try {
      if (!existsSync(file)) return fallback;
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return check(parsed) ? (parsed as T) : fallback;
    } catch {
      return fallback;
    }
  };

  const writeJson = (file: string, value: unknown): void => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(value));
    } catch {
      // Disk full or read-only — persistence is a nice-to-have, never fatal.
    }
  };

  return {
    loadLedger: () => readJson<LegacyLedger>(ledgerFile, emptyLedger(), isLedger),
    saveLedger: (ledger) => writeJson(ledgerFile, ledger),
    loadHistory: () =>
      readJson<MatchRecord[]>(historyFile, [], (v) => Array.isArray(v)),
    saveHistory: (history) => writeJson(historyFile, history),
  };
}
