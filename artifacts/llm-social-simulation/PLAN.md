# Roadmap: Social-Deduction Game (Among Us-style, original IP)

## 0. Status

Implemented and playable. Everything from Phases 0-6 below has landed in
`src/`, and the headless checks in `scripts/` prove it:

| Phase | Status | Where |
|---|---|---|
| 0 — Scaffold & tooling | done | Vite + React + TS + Tailwind, vitest replaced by `scripts/validate-*.ts` under bun |
| 1 — Map & rendering | done | `src/game/map.ts`, `src/game/render/renderMap.ts` |
| 2 — Core player mechanics | done | `src/game/player.ts`, `collision.ts`, `vision.ts` (fog), `tasks.ts` + `components/TaskModal.tsx` |
| 3 — Game loop & state machine | done | `src/game/engine.ts` (phases, win conditions, bodies, ejections) |
| 4 — AI agents | done | `src/ai/` (model + heuristic), `src/game/perception.ts`, `crewmate.ts`, `imposter.ts` |
| 5 — Social systems & meetings | done | `src/game/engine.ts` meeting loop, `src/game/dialogue.ts`, `components/MeetingOverlay.tsx` |
| 6 — UI/UX & theme | done | `src/App.tsx`, `src/components/*` |
| 7 — Persistence & evaluation | partial | match history + transcripts + belief snapshots in `src/game/persistence.ts` (localStorage); `src/game/legacy.ts` carries reputations and grudges *between* shifts; Convex tables and replay UI still to do |
| 8 — Polish & deploy | partial | production build verified; audio/accessibility passes outstanding |
| 9 — Watchability | done | generative log consoles (`src/game/creative.ts`), the per-agent confessional, and the cross-match ledger — see "Watching it" below |

The decisions below that differ from this original plan:

- **Persistence is `localStorage`, not Convex.** The Convex schema stub remains at
  `src/convex/schema.ts`, but nothing depends on a deployed backend, so the game
  works offline and matches are still recorded with full transcripts.
- **Model calls are client-side**, straight to the OpenAI-compatible Berget AI
  endpoint (CORS-enabled). No `"use node"` action is involved; the key is inlined
  into the bundle, which is fine for a demo and documented in the README.
- **Votes are computed from the belief model, never from the model**, so agent
  claims can be audited against agent beliefs.
- **Vitest was dropped** in favour of bun-run headless scripts that replay whole
  matches; they assert on outcomes rather than on units.

### Watching it (post-Phase 6 pass)

The simulation was readable but not *watchable*: everything an agent knew was
in a transcript, and nothing it did produced anything to look at. Three systems
fixed that, and each is deliberately cheap because the budget is a real
constraint:

- **Generative log consoles** (`src/game/creative.ts`). Ten of the fifteen task
  consoles now ask the agent to write a sentence — a scan readout, an intercept
  summary, a note on what was clogging the filter. The entry becomes a public
  station log that every agent remembers and can quote, and an impostor's
  cover story is filed alongside the real ones. Chosen so every AI crewmate's
  *first* assigned console is generative, which is what makes the log fill in
  the opening minute instead of racing the endgame.
- **The confessional.** Every decision and meeting line carries the agent's
  private thought as a second channel, the room never sees it, and a traitor's
  is labelled a cover story. It is gated behind spectator mode / the verdict /
  an explicit spoiler click, because it hands you the answer.
- **The cross-match ledger** (`src/game/legacy.ts`). Wins, eliminations and
  grudges persist between shifts, and a mislynched agent blames every voter.
  The bias is capped at `MAX_GRUDGE`, below the threshold at which an agent acts
  on a suspicion, so it shades the opening read without deciding a match.

One engine change came out of this: AI crewmates never marked a console off
`a.tasks`, so `hasUrgentInteraction` kept offering the same console and they
re-worked it for the whole match instead of walking their assignment. With the
mark restored they patrol their list, which is what makes the generative
consoles reachable at all — and slows the task bar, so games now lean slightly
further toward the imposters than they did.

## 1. Current State Review

The repository is **empty except for a README and a single commit** — there is no
application code, no build tooling, and no dependencies yet.

```
.
├── .git/
└── README.md        # "LLM Social Simulation" — vision statement only
```

- **Commit history:** one commit (`5708fa4 Add README`).
- **Build tooling:** none. No `package.json`, lockfile, `src/`, `tsconfig`, or config files.
- **Backend/database:** none wired up.
- **Tests:** none.
- **Remote:** `origin` → `Marcus-Mok-GH/llm-social-simulation`.

**Conclusion:** this is a greenfield project. Everything below must be built from
scratch, starting with the application scaffold.

### Naming / IP note
> "Among Us", "The Skeld", and Innersloth's characters and art are copyrighted.
> This project **keeps the Skeld's *layout concept*** (a set of rooms connected by
> corridors, with a task loop and a hidden-traitor mechanic) but replaces every
> copyrighted asset: an original game name, original room names, original
> geometry/art, original terminology, and original sound. Layout *ideas* and game
> *mechanics* are not protectable; specific expression and names are.

## 2. Target Product

A browser-playable social-deduction game where a human player is one crew member
among AI-driven crewmates and one or more AI imposters. The AI agents are the
research focus (matching this repo's "LLM Social Simulation" theme): they should
**perceive, remember, reason, act, and socially coordinate/deceive** — not just
follow scripted state machines.

## 3. Recommended Tech Stack

| Layer        | Choice                                             | Why |
|--------------|----------------------------------------------------|-----|
| App shell    | Vite + React + TypeScript (Freebuff template)      | Matches workspace; fast HMR-less dev; easy deploy. |
| Rendering    | HTML5 Canvas 2D (to start), PixiJS later if needed | Top-down game render loop; Canvas is dependency-light and sufficient for a 2D map. |
| Styling      | Tailwind + shadcn/ui                               | Landing page, HUD, meeting UI. |
| Backend/DB   | Convex                                             | Game persistence, agent memory, match history, server-side LLM calls. |
| AI decisions | LLM via a Convex `"use node"` action               | Drives crewmate/imposter reasoning and meeting dialogue. |
| Pathfinding  | A* over a grid derived from the map data           | AI navigation around walls. |
| Tests        | Vitest                                             | Unit-test simulation/game logic deterministically. |

## 4. High-Level Development Phases

### Phase 0 — Scaffold & Tooling
- Initialize Vite + React + TS app, Tailwind, shadcn/ui, Convex.
- Set up project structure: `src/game/` (engine), `src/ai/` (agents), `src/components/` (UI), `src/convex/` (backend).
- Vitest + a deterministic simulation tick loop.
- Establish the preview/build commands so the app runs from day one.

### Phase 1 — Map & Rendering (the "Skeld-like" layout)
- Encode the map as **data** (rooms, corridors, doors, task consoles, vents, spawn points) — original names, Skeld-inspired topology.
- Canvas renderer: rooms/corridors, camera follow, zoom, walls.
- Collision (walls block movement) + a walkable grid for pathfinding.
- Minimap and a "you are here" marker.

### Phase 2 — Core Player Mechanics
- Top-down player movement, animation, and interaction radius.
- **Line-of-sight / vision fog** with wall occlusion (the core tension mechanic).
- Task system: task points on the map, a few original mini-games, per-crew progress bar.
- Imposter abilities: kill, vent, sabotage (lights/door/reactor-style), cooldowns.

### Phase 3 — Game Loop & State Machine
- Lobby → role assignment (N crew, M imposters) → play round → emergency meeting → voting → resolution.
- Win conditions: all tasks done / imposters ejected / crew outnumbered.
- Bodies, reporting, discussion timer, ejection flow, dead-player spectator mode.

### Phase 4 — AI Agents (the differentiator)
- **Perception layer:** agent sees only what line-of-sight allows (no cheating).
- **Memory:** observations, sightings, who-was-where, recent events.
- **Decision loop (LLM):** a periodic tick where each agent produces an intent (go to task, follow, avoid, kill, vent, fake a task) using its memory + current beliefs.
- Crewmate behavior: task execution, pathing, grouping, note-taking.
- Imposter behavior: opportunistic kills when unwitnessed, alibi maintenance, self-reporting, false accusation.
- Graceful fallback to scripted behavior if the LLM call is unavailable (never stalls the game).

### Phase 5 — Social Systems & Meetings
- Meeting/chat: human + AI dialogue with turn-taking and a time budget.
- Belief model: trust, suspicion, alibi, "who was near the body".
- Voting logic driven by each agent's suspicion scores, not a fixed rule.
- Post-game reasoning trace for debugging/analysis.

### Phase 6 — UI/UX & Theme (original IP)
- Themed landing page (strong visual identity, no purple/pink gradient clichés).
- Auth + dashboard shell via the Freebuff template.
- HUD, task list, role reveal, meeting screen, chat, results screen.

### Phase 7 — Persistence, Tuning & Evaluation
- Convex schema: matches, players, agent memories, transcripts.
- Save/load and match history; replayable transcripts.
- Balance passes; measurable agent-quality metrics (does deception work? do crewmates reason well?).

### Phase 8 — Polish & Deploy
- Performance (render budget, tick rate), accessibility, responsive layout.
- Audio (original cues), transitions/motion.
- Production deploy via Freebuff hosting.

## 5. Immediate Next Coding Steps

1. **Scaffold the app** — Vite + React + TS + Tailwind + shadcn/ui, and wire Convex. Get a running preview.
2. **Define the map data model** (`src/game/map/`) — rooms/corridors/doors/tasks as typed data with the original names, derived from the Skeld topology.
3. **Build the Canvas renderer + camera** — draw the map, follow the human player.
4. **Implement player movement + wall collision**, then derive a walkable grid for A*.
5. **Add line-of-sight fog** — the mechanic everything else depends on.
6. Only then layer in tasks, roles, and the AI tick (Phases 2–4).

**Rationale for ordering:** the map + movement + vision loop is the smallest vertical
slice that proves the game "feels" right. AI agents and multiplayer/social systems
depend on a stable, observable simulation, so they come after it.
