# Umbra Station — LLM Social Simulation

A browser-playable social-deduction game where the other players are LLM-driven
agents. You are one crew member aboard a space station: crew run tasks, hidden
imposters lie, kill and sabotage. The AI agents are the research subject — they
**perceive** only what line of sight allows, **remember** it, **reason** about who
to trust, and **argue and vote** in meetings.

## What's implemented

| System | Notes |
|---|---|
| Map & renderer | 12 rooms / 15 corridors, Canvas 2D, camera-fit, A\* navigation grid |
| **Vision fog** | Ray-cast visibility polygon + persistent "explored" memory, with wall occlusion |
| Player | WASD movement, wall collision, contextual actions, spectator mode when dead |
| **Tasks** | Per-agent task lists, shared station bar, two playable minigames (wiring, calibration) |
| **Kills & bodies** | Proximity kill with a real witness check (line of sight within 230u), corpses, reporting |
| **Sabotage** | Reactor meltdown (45s) and grid overload (halves every agent's vision), fixed by standing on the console |
| **Meetings** | Report or emergency beacon → discussion → voting → tally → ejection |
| **Belief model** | Per-agent memory ring + suspicion vector with decay, vent sightings, body-room inference |
| **LLM decision loop** | Berget AI (OpenAI-compatible) returns validated JSON intents and meeting lines; heuristic fallback on any failure |
| **Persistence** | Finished matches, transcripts and every agent's suspicion snapshot saved to `localStorage` |
| Analyst view | Optional overlay showing each agent's current top suspect |

Mechanics, room names, art and terminology are original IP. The layout keeps the
*concept* of a ship with rooms joined by corridors and a hidden-traitor loop.

## Run

```bash
pnpm install                                   # from the workspace root
pnpm --filter @workspace/llm-social-simulation run dev
```

The Vite config requires `PORT` and `BASE_PATH` (the Replit artifact supplies
them). For a local run:

```bash
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/llm-social-simulation run dev
```

Production build: `pnpm --filter @workspace/llm-social-simulation run build`
(`dist/public`).

## Model configuration

The game talks to an OpenAI-compatible chat-completions endpoint directly from
the browser. CORS is enabled by Berget AI, and the endpoint was verified against
`https://api.berget.ai/v1`.

| Variable | Default | Purpose |
|---|---|---|
| `BERGET_API_KEY` | — | API key. Read from the environment via Vite's `envPrefix`. |
| `VITE_LLM_API_KEY` | — | Explicit override for the key. |
| `BERGET_BASE_URL` / `VITE_LLM_BASE_URL` | `https://api.berget.ai/v1` | Endpoint. |
| `BERGET_MODEL` / `VITE_LLM_MODEL` | `mistral-small` | Model id. |
| `VITE_LLM_TIMEOUT_MS` | `15000` | Per-request timeout. |

With no key at all the game still plays end to end — every agent falls back to
the scripted, belief-driven heuristic, and the HUD says so.

> **Deployment note:** this is a client-only app, so the key is inlined into the
> production bundle. Anyone who can load the page can read it. Put it behind a
> small proxy if that matters for your deployment.

## Verify

```bash
pnpm --filter @workspace/llm-social-simulation run check       # typecheck + all headless checks
pnpm --filter @workspace/llm-social-simulation run simulate    # full matches, 60 Hz, no network
BERGET_API_KEY=... pnpm --filter @workspace/llm-social-simulation run verify:llm
```

- `scripts/validate-*.ts` — map data, collision, renderer draw calls (including
  the fog layer and analyst view), the React tree rendered to a string, crewmate
  pathing, imposter behaviour.
- `scripts/simulate.ts` — replays complete matches headlessly and asserts that
  perception, memory, kills, meetings, ejections, the task bar and the win
  conditions all actually fired. Deterministic: same seed, same result.
- `scripts/verify-llm.ts` — exercises the real network path: one movement intent,
  one crew statement and one imposter deflection, each validated exactly as the
  engine validates them.

## Layout

```
src/
  ai/       llm.ts (transport + JSON extraction), decision.ts (intents, dialogue, fallbacks)
  game/     engine.ts (phases, perception, kills, meetings, win conditions)
            vision.ts, perception.ts, tasks.ts, dialogue.ts, persistence.ts, map.ts,
            collision.ts, navigation.ts, crewmate.ts, imposter.ts, player.ts, rng.ts
            render/renderMap.ts
  components/ GameStage.tsx, GameHud.tsx, MeetingOverlay.tsx, TaskModal.tsx, GameOverlays.tsx
scripts/    validate-*.ts, simulate.ts, verify-llm.ts
```

## Next

Phase 7 in `PLAN.md`: Convex-backed match storage and replay (the schema stub is
in `src/convex/schema.ts`), plus auth and shareable transcripts.
