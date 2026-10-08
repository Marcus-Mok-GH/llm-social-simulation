/**
 * UI smoke test.
 *
 * No browser is available in CI, so the component tree is rendered to a string
 * instead: this catches crashes in component code, bad hook usage during render,
 * and a missing overlay/HUD that the game would otherwise only reveal at runtime.
 *
 * Run: bun scripts/validate-ui.tsx
 */
import { renderToString } from "react-dom/server";
import App from "../src/App";
import { EndScreen } from "../src/components/GameOverlays";
import type { Snapshot } from "../src/game/engine";
import type { MatchRecord } from "../src/game/persistence";

const html = renderToString(<App />);
const checks: [string, boolean][] = [
  ["renders the station title", html.includes("UMBRA STATION")],
  ["renders the hero", html.includes("Trust no one")],
  ["renders the pre-shift briefing", html.includes("The deck is")],
  ["offers spectating as the only way in", html.includes("SPECTATE THE SHIFT")],
  [
    "offers no way to play",
    !html.includes("BEGIN SHIFT") &&
      !html.includes("TAKE THE CREW SEAT") &&
      !html.includes("WASD"),
  ],
  ["renders the HUD task bar", html.includes("STATION TASKS")],
  ["renders the per-agent model line", html.includes("different model")],
  ["renders the map legend", html.includes("Task console")],
  ["has a canvas", html.includes("<canvas")],
  // The watchability read-out below the deck: the confessional. (The station
  // log and agent-thought panels were removed in 72101a9; their data still
  // ships in every record — only the always-visible panels went.)
  ["renders the confessional", html.includes("CONFESSIONAL")],
  // …and the confessional is sealed at first, because it spoils the match.
  ["seals the confessional until asked", html.includes("SEALED")],
  ["offers the spoiler reveal", html.includes("REVEAL")],
  // The broadcast front door: title card, cast, standings, features.
  ["renders the ON AIR header", html.includes("ON AIR")],
  ["renders the cast manifest", html.includes("CAST MANIFEST")],
  ["renders the standings ladder", html.includes("STANDINGS")],
  ["renders the feature grid", html.includes("WHY IT IS WORTH WATCHING")],
  ["offers CTAs into the shift", html.includes("WATCH THE SHIFT")],
];

// The end screen is only reachable once a match resolves, so render it directly
// with a finished-match record. This is what proves the recap is wired into the
// verdict screen rather than merely existing as a module.
const record: MatchRecord = {
  id: "test",
  startedAt: 0,
  endedAt: 100000,
  durationSec: 125,
  winner: "imposter",
  playerRole: "crew",
  roster: [
    { key: "crew:0", name: "AI-1", role: "crew", alive: false },
    { key: "crew:2", name: "AI-3", role: "crew", alive: false },
    { key: "imp:0", name: "AI-5", role: "imposter", alive: true },
  ],
  meetings: 1,
  ejects: 1,
  tasksComplete: 3,
  tasksTotal: 19,
  llm: { calls: 0, fallbacks: 0 },
  transcript: [],
  beliefs: [],
  events: [
    { kind: "kill", t: 20, killerKey: "imp:0", killerName: "AI-5", victimKey: "crew:0", victimName: "AI-1", roomName: "Electrical", witnessed: false },
    { kind: "meeting", t: 40, reason: "report", byKey: "crew:2", byName: "AI-3" },
    { kind: "eject", t: 60, key: "crew:2", name: "AI-3", role: "crew", voters: ["AI-5"] },
    { kind: "end", t: 120, winner: "imposter", reason: "The imposters outnumber the crew." },
  ],
  confessional: [
    { t: 21, name: "AI-5", role: "imposter", action: "killed AI-1", thought: "Nobody was watching." },
  ],
};

const endSnap = {
  winner: "imposter",
  role: "crew",
  tasks: [],
  meetings: 1,
  ejects: 1,
} as unknown as Snapshot;

const endHtml = renderToString(
  <EndScreen snap={endSnap} history={[record]} onRestart={() => {}} />,
);
checks.push(
  ["renders the recap panel", endHtml.includes("STORY OF THE SHIFT")],
  ["frames a misplaced vote as a mislynch", endHtml.includes("THE MISLYNCH")],
  ["offers the next shift, not a role to play", endHtml.includes("NEXT SHIFT") && !endHtml.includes("PLAY AS")],
);
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}
console.log(`\nrendered ${html.length} bytes of HTML (+ ${endHtml.length} bytes of end screen)`);
process.exit(bad > 0 ? 1 : 0);
