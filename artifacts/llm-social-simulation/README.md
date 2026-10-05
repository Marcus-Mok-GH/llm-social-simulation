# Umbra Station — LLM Social Simulation

A browser-playable social-deduction game where the other players are LLM-driven
agents. You are one crew member aboard a space station: crew run tasks, hidden
imposters lie, kill and sabotage. The AI agents are the research subject — they
**perceive** only what line of sight allows, **remember** it, **reason** about who
to trust, and **argue and vote** in meetings.

## What's implemented

| System | Notes |
|---|---|
| Map & renderer | The official Skeld artwork as the deck, Canvas 2D, camera-fit, A\* navigation grid |
| **Vision fog** | Ray-cast visibility polygon + persistent "explored" memory, with wall occlusion |
| Player | WASD movement, wall collision, contextual actions, spectator mode when dead |
| **Tasks** | Per-agent task lists, shared station bar, two playable minigames (wiring, calibration) |
| **Interactions** | Agents choose `INTERACT` (`TASK`/`KILL`/`FIX`/`REPORT`/`EMERGENCY`) against objects in their current node; the engine re-checks distance, game state and line of sight, rejects illegal actions and feeds the reason back as `system_message` |
| **Kills & bodies** | Kill is a validated interaction with a real witness check (line of sight within 230u), corpses, reporting |
| **Sabotage** | Reactor meltdown (45s — repaired at a Reactor hand scanner) and lights out (halves every agent's vision — repaired in Electrical) |
| **Meetings** | Report or emergency beacon → discussion → voting → tally → ejection |
| **Belief model** | Per-agent complete match log (every event, sighting, decision and meeting, from start to finish) + suspicion vector with decay, vent sightings, body-room inference |
| **LLM decision loop** | A configurable OpenAI-compatible provider (Pollinations or Berget) returns validated JSON intents (`MOVE`/`INTERACT`/`VENT`/`SABOTAGE`) and meeting lines; each AI agent runs a **different** model from a cheap-model pool, with heuristic fallback on any failure |
| **Persistence** | Finished matches, transcripts and every agent's suspicion snapshot saved to `localStorage` |
| Analyst view | Optional overlay showing each agent's current top suspect |
| **Deck artwork** | The official Skeld art (`public/skeld-map.webp`) is the deck itself: actors, task markers and fog render on top of it |

**Map provenance.** The deck layout is The Skeld from *Among Us* — 14 rooms plus
the named Hallway, the halls and doors of the real ship (11 walkable links:
Northwest / Northeast / Central / West / Southwest / Southeast halls plus the
O2, Weapons, Navigation and Shields doors), 14 vent grates in six chains, four
hallway cameras, and the sabotage consoles where they are on the real map.

Every room and corridor rectangle is *measured off the artwork itself*: each box
was traced from the dark wall runs in `public/skeld-map.webp` and then converted
to world coordinates by `scripts/gen-map-geom.ts` (1800×1007 art → 1920×1200
world). Rooms sit a few pixels inside their drawn walls so a 15px actor can
never clip a hull corner, and corridors overlap the rooms they join so the
navigation grid's clearance circle can walk every seam. Collision, the nav grid
and the fog grid are all derived from that one set of rectangles, so what you
see is what you can walk.

All of it lives as data in `src/game/map.ts`; the artwork in
`public/skeld-map.webp` is © Innersloth and is drawn as the deck, with the game
markers and fog composited over it.
Everything else — station name, crew, roles, dialogue, task presentation and the
rest of the art — is original.

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

The game talks to OpenAI-compatible chat-completions endpoints directly from the
browser. Two providers are supported and both are CORS-enabled. **Pollinations
is preferred when its key is present**, and every AI agent is assigned its own
model from the provider's pool — in the normal 4-crew + 2-imposter match, all six
AI players are different models.

| Variable | Default | Purpose |
|---|---|---|
| `POLLINATIONS_API_KEY` / `VITE_POLLINATIONS_API_KEY` | — | Pollinations key (app `pk_` keys are safe for browsers; `sk_` keys are server-only). |
| `VITE_POLLINATIONS_BASE_URL` | `https://gen.pollinations.ai/v1` | Pollinations endpoint. |
| `VITE_POLLINATIONS_MODELS` | see below | Comma-separated override for the model pool. |
| `BERGET_API_KEY` / `VITE_LLM_API_KEY` | — | Berget key. |
| `BERGET_BASE_URL` / `VITE_LLM_BASE_URL` | `https://api.berget.ai/v1` | Berget endpoint. |
| `BERGET_MODEL` / `VITE_LLM_MODEL` | `mistral-small` | Berget model (Berget has no model pool). |
| `VITE_LLM_PROVIDER` | auto | Pin `pollinations` or `berget` when both keys are set. |
| `VITE_LLM_TIMEOUT_MS` | `15000` | Per-request timeout. |

### Why these Pollinations models

The pool is six cheap, **official** models — community models are excluded because
they can vanish mid-match:

```
openai/gpt-6-luna   openai/gpt-5-nano   minimax/minimax-m3
deepseek/deepseek-v4.1-flash   mistralai/mistral-large-3   openai/gpt-5.4-nano
```

Two Pollinations details matter:

- **Quest Pollen only covers the eligible catalog**, while paid Pollen unlocks the
  full one. A key with a Quest balance but no paid balance gets
  `402 INSUFFICIENT_BALANCE` on models outside that catalog, which is why every
  model here was picked from the Quest-eligible set.
- A match fires up to 150 model calls, so the whole pool is priced in fractions of
  a Pollen per million tokens. GPT-5 Nano and GPT-6 Luna need JSON mode to answer,
  which the game always requests.

Set `VITE_POLLINATIONS_MODELS` to replace the pool (for example with models your
key is scoped to).

With no key at all the game still plays end to end — every agent falls back to
the scripted, belief-driven heuristic, and the HUD says so.

> **Deployment note:** this is a client-only app, so the key is inlined into the
> production bundle. Anyone who can load the page can read it. Put it behind a
> small proxy if that matters for your deployment.

## Verify

```bash
pnpm --filter @workspace/llm-social-simulation run check       # typecheck + all headless checks
pnpm --filter @workspace/llm-social-simulation run simulate    # full matches, 60 Hz, no network
POLLINATIONS_API_KEY=... pnpm --filter @workspace/llm-social-simulation run verify:llm
```

- `scripts/validate-*.ts` — map data, collision, renderer draw calls (including
  the deck artwork, fog layer and analyst view), the React tree rendered to a
  string, crewmate pathing, imposter behaviour.
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
