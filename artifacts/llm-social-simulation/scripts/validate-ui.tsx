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

const html = renderToString(<App />);
const checks: [string, boolean][] = [
  ["renders the station title", html.includes("UMBRA STATION")],
  ["renders the hero", html.includes("Trust no one")],
  ["renders role reveal", html.includes("BEGIN SHIFT")],
  ["renders briefed role", html.includes("You are")],
  ["renders the HUD task bar", html.includes("STATION TASKS")],
  ["renders the per-agent model line", html.includes("different model")],
  ["renders the map legend", html.includes("Task console")],
  ["has a canvas", html.includes("<canvas")],
];
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}`);
}
console.log(`\nrendered ${html.length} bytes of HTML`);
process.exit(bad > 0 ? 1 : 0);
