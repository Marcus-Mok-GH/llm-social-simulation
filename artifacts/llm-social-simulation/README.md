# Umbra Station — LLM Social Simulation

A social-deduction match you *watch*, where every player is an LLM-driven
agent. Six AIs hold the seats aboard a space station: crew run tasks, hidden
imposters lie and kill — and the traitors are drawn at random from
the cast before every shift, a different pair each match. You spectate from the
gallery. The AI agents are the research subject — they **perceive** only what
line of sight allows, **remember** it, **reason** about who to trust, and
**argue and vote** in meetings.

## What's implemented

| System | Notes |
|---|---|
| Map & renderer | The official Skeld artwork as the deck, Canvas 2D, player-following camera at fixed zoom, A\* navigation grid |
| **Vision fog** | Ray-cast visibility polygon + persistent "explored" memory, with wall occlusion |
| **Viewer** | Spectating only — full deck vision, analyst overlay, spoken meeting lines and the spoiler-gated confessional. There is no seat to take: the AIs play the whole match |
| **Tasks** | Per-agent task lists built to the Among Us docs' job sizes (5 short + 2 long per crewmate), shared station bar, two minigame formats (wiring, calibration) |
| **Interactions** | Agents choose `INTERACT` (`TASK`/`KILL`/`REPORT`/`EMERGENCY`) against objects in their current node; the engine re-checks distance, game state and line of sight, rejects illegal actions and feeds the reason back as `system_message` |
| **Kills & bodies** | Kill is a validated interaction with a real witness check (line of sight within 230u), corpses, reporting |
| **Sabotage & vents — removed** | No agent can trigger a sabotage or travel by vent any more; the traitor's toolkit is the kill, the lies, and the crowd. (The referee machinery stays in the engine only so the headless checks can still drive it directly.) |
| **Meetings** | Report a body, or press the emergency beacon — AI crewmates walk to the Cafeteria beacon and call one themselves when they have a real lead → discussion → voting → tally → ejection |
| **Belief model** | Per-agent complete match log (every event, sighting, decision and meeting, from start to finish) + suspicion vector with decay, body-room inference |
| **LLM decision loop** | A configurable OpenAI-compatible provider (Pollinations or Berget) returns validated JSON intents (`MOVE`/`INTERACT`) and meeting lines; each AI agent runs a **different** model from a cheap-model pool, with heuristic fallback on any failure |
| **Deception & identification** | Every traitor is handed a persona (wire-puller / provocateur / confidant / ghost) and lies in meetings with structured claims — `accuse`, `vouch`, `alibi`. Every listener weighs a claim against its own memory: an unverifiable smear only shades suspicion, but a claim its own eyes contradict brands the speaker a liar (`caught`) — the crew's way of identifying imposters |
| **Autonomous station host** | The match runs server-side in the preview process: it starts on its own, keeps ticking with the tab closed (every shift is spectated, so the six AIs play the whole match), folds every shift into the cross-match ledger and chains the next one — the browser is a viewer that can close and rejoin |
| **Persistence** | Finished matches, transcripts and every agent's suspicion snapshot saved to `localStorage` in local mode, and to the shared server-side history when the shift runs on the host |
| **Station log** | Ten consoles ask the crew to *write* a line (a scan readout, an intercept summary, a cargo note) instead of waiting out a timer. Entries are public — every agent can quote them in a meeting — and a traitor writes a cover story |
| **Confessional** | Every decision and meeting line carries the agent's private thought, one channel underneath the public one. Sealed through the briefing (it spoils the match), legible the moment you are watching |
| **Cross-match ledger** | Wins, eliminations and grudges survive between shifts. An agent voted out blames every voter and opens the next match already watching them |
| **Match recap** | A structured timeline of the shift (kills, meetings, ejections, verdict) is recorded as it happens and the end screen re-tells it as a short *story of the shift* — a spotlight on the decisive beat (the mislynch, the clean kill), then the full beat sheet and the closing private thought |
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
pnpm dev                                       # the station host (what the preview runs)
pnpm dev:vite                                  # plain Vite, client-only (no hosted match)
```

`pnpm dev` starts **the station host**: a single Node/Bun process that serves
the app through Vite's dev middleware (HMR included) *and* runs the match on
the same port. It is the same command the Freebuff preview runs.

The Vite config requires `PORT` and `BASE_PATH` (the Replit artifact supplies
them). For a local run:

```bash
PORT=5173 BASE_PATH=/ pnpm dev
```

Production build: `pnpm --filter @workspace/llm-social-simulation run build`
(`dist/public`).

## The match runs on the station — close the tab, it keeps playing

The engine has no wall clock: it only advances through `tick(dt)`. The station
host exploits that — it owns the `GameEngine`, ticks it on a timer, and serves
the browser as a **viewer**:

- **Autonomous from the first second.** A fresh shift briefs itself, begins
  in spectator mode after a few seconds whether or not anyone is watching,
  plays to a verdict, writes the record, folds the outcome into the ledger,
  and builds the next shift — including a fresh random draw of which AIs are
  the traitors. Nothing waits for a client.
- **Closing the tab only pauses the viewer.** State flows server → browser as
  SSE frames (`hello` on attach, then `state` at 10 Hz, interpolated to smooth
  motion) and input flows back as small POSTs on `/__umbra/*`. No WebSocket
  upgrade, so it survives the preview proxy; `EventSource` retries on its own.
- **Rejoin lands on the same shift.** The viewer is tracked by a session id
  stored in `localStorage`. The same browser reconnecting to a live shift gets
  `hello` with the same `matchId` and whatever minute the match has reached
  while you were away; a second browser only watches.
- **Nobody plays the human body — it isn't on the deck.** Every shift opens in
  spectator mode, so the player seat departs the roster (the dead-player path)
  and the six AIs play the match end to end, bound by the same engine referee
  as always. There is no control surface left for a human to hold.
- **The learning is server-side.** Every shift — watched or not — folds into
  `.data/ledger.json` (grudges, wins, eliminations) and `.data/matches.json`
  (the shared history), both re-read on host start, so the agents open the
  next match remembering the last one even across a restart.
- **Nothing hosted? Nothing lost.** If no host answers within five seconds
  (e.g. a static build), the page falls back to the original in-page engine
  and runs the same spectated shift locally — just without cross-tab
  persistence.

`scripts/validate-host.ts` boots the real thing headlessly and asserts all of
it: ticking with zero viewers, seat reclaim on rejoin, gallery-only second
viewers, whole matches run without a client, and ledger/history surviving a
fresh host process.

## Model configuration

The game talks to OpenAI-compatible chat-completions endpoints directly from the
browser. Two providers are supported and both are CORS-enabled. **Pollinations
is preferred when its key is present**, and every AI agent is assigned its own
model from the provider's pool — in the 4-crew + 2-imposter match the crew and
the traitors never share a model. **The traitors are drawn at random from the
pool at the start of every shift**: any model can be the imposter, a traitor
model never also plays honest crew *within* a match, and the draw avoids the
pair that played them last shift — so no two shifts in a row open with the same
traitors.

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

The pool is five cheap, **official** models — community models are excluded
because they can vanish mid-match:

```
openai/gpt-6-luna   nvidia/nemotron-3.5-lightning   minimax/minimax-m3
deepseek/deepseek-v4.1-flash   mistralai/mistral-large-3
```

Two Pollinations details matter:

- **Quest Pollen only covers the eligible catalog**, while paid Pollen unlocks the
  full one. A key with a Quest balance but no paid balance gets
  `402 INSUFFICIENT_BALANCE` on models outside that catalog, which is why every
  model here was picked from the Quest-eligible set.
- **Any model can be the traitor.** The engine draws two imposters at random
  from the pool before every shift (avoiding the pair that played them last
  one), so the traitors rotate match to match — the models that drew the knife
  are the only ones kept out of that shift's crew pool.
- A match fires up to 150 model calls, so the whole pool is priced in fractions of
  a Pollen per million tokens. GPT-6 Luna needs JSON mode to answer,
  which the game always requests.

Set `VITE_POLLINATIONS_MODELS` to replace the pool (for example with models your
key is scoped to).

With no key at all the game still plays end to end — every agent falls back to
the scripted, belief-driven heuristic, and the HUD says so.

### What the watchability layer costs

The three systems that make a match worth *watching* rather than merely reading
(see below) are built to stay inside that same budget:

- a station-log entry is **text only** — one sentence, 200 max tokens, low
  reasoning effort — and a match may spend at most `LOG_MODEL_CALLS_MAX` (4)
  live calls on the whole log, after which the console's deterministic template
  fills in;
- the confessional adds **no calls at all**: it rides on the `reasoning` the
  intent already returns and the `thinking` field the meeting call already
  answers with, and is synthesised from the agent's own beliefs when running on
  the heuristic;
- the ledger is pure storage — no model is ever consulted about a grudge. It
  lives in `localStorage` for browser-local shifts and in `.data/ledger.json`
  for shifts the station host runs.

> **Deployment note:** this is a client-only app, so the key is inlined into the
> production bundle. Anyone who can load the page can read it. Put it behind a
> small proxy if that matters for your deployment.

## Verify

```bash
pnpm --filter @workspace/llm-social-simulation run check       # typecheck + all headless checks
pnpm --filter @workspace/llm-social-simulation run simulate    # full matches, 60 Hz, no network
POLLINATIONS_API_KEY=... pnpm --filter @workspace/llm-social-simulation run verify:llm
```

- `scripts/validate-host.ts` — boots the real station (HTTP + SSE + engine)
  on an ephemeral port and proves the host's promises: the shift keeps
  ticking with zero viewers, a viewer that reconnects with the same session
  id gets its crew seat back on the *same* shift at a later match time, a
  second viewer only watches, whole matches run headlessly to a verdict, and
  the ledger + history survive a fresh host process reading the same `.data`
  directory.

- `scripts/validate-*.ts` — map data, collision, renderer draw calls (including
  the deck artwork, fog layer and analyst view), the React tree rendered to a
  string, crewmate pathing, imposter behaviour.
- `scripts/simulate.ts` — replays complete matches headlessly and asserts that
  perception, memory, kills, meetings, ejections, the task bar and the win
  conditions all actually fired. Deterministic: same seed, same result.
- `scripts/validate-watchability.ts` — the three watchability systems, mostly
  offline: the log templates are deterministic, a traitor's confessional is
  always a cover story, a grudge is capped below the threshold an agent acts on,
  and the ledger round-trips through the engine (including the end-of-match fold
  the UI performs).
- `scripts/validate-deception.ts` — the deception layer: every persona is
  distinct, an alibi or accusation that clashes with the listener's own sighting
  is caught (and a stale one is not), a bad vouch for someone the listener
  watched vent is caught, an unchallenged accusation raises suspicion but never
  past the vote threshold, and a whole model-free match actually produces public
  accusations — all through the real `remember` belief path.
- `scripts/validate-recap.ts` — the recap layer: real matches emit an ordered,
  well-formed timeline (kills name a killer/victim/room and whether they were
  seen, ejections carry the true role and voters, the verdict is always last),
  and `buildRecap` is pure — a mislynch outranks a clean kill for the spotlight,
  the closing quote prefers a surviving liar, and the same record re-narrates
  identically.
- `scripts/verify-llm.ts` — exercises the real network path: every model in the
  pool in JSON mode, then two movement intents, two meeting statements (both of
  which must come back with a private `thinking` line) and two station-log
  entries, each validated exactly as the engine validates them.

## Why it is worth watching

A social-deduction match is only interesting if there is something to watch
besides a transcript. Three systems carry that, and all three are survival
instincts for the agents rather than decoration:

1. **The agents write.** Ten consoles ask for a line instead of a wait, and the
   resulting station log is *public* — every agent remembers it and can quote it
   in a meeting. A crew readout is flavour; an impostor's cover story filed next
to it is evidence, and the two sit in the same scroll box.
2. **You can hear what they really think.** Each decision carries a private
   thought, and each meeting line carries a `thinking` field the room never
   hears. A crew note is usually just an honest read of the room; a traitor's is
a cover story, and the panel labels which is which. The gap between the two
channels is the show — sealed through the briefing, open the moment you are
watching.
3. **They remember the last shift.** The ledger keeps wins, eliminations and
   grudges between matches, and an innocent who gets voted out blames every name
   on the ballot. Next match they open already watching those agents — a bias
   capped well below the threshold at which anyone acts on a suspicion, so last
   shift's drama colours the read without ever outvoting this shift's evidence.

Those channels are raw material; the **recap** is the edit. Every kill,
meeting, ejection and verdict is banked as a structured event as it happens, and
the end screen folds that timeline — plus the confessional — into a compact
story with one spotlighted beat and the line the audience takes away. It is
pure and deterministic, so a saved match re-narrates identically.

## Deception and identification

A traitor that only follows the room is not a traitor. Both sides of the lie are
simulated:

- **Every traitor gets a persona.** The roster hands each of them one of four
  playbooks — a patient **wire-puller**, a loud **provocateur**, a trust-building
  **confidant**, or a quiet **ghost** — carried in the decision and meeting
  prompts and in the offline fallback, so two traitors never lie the same way.
- **They lie in structured claims, not prose.** A meeting line can carry an
  `accuse`, a `vouch` or an `alibi`. It is the claim, not the sentence, that the
  room acts on: an unchallenged accusation nudges every listener's belief about
  the target, and a vouch is the only thing in the game that pulls a belief back
  down. A single accusation is deliberately weighted below the vote threshold,
  so manipulation has to be corroborated to convict anyone.
- **The crew is trying to catch them.** `judgeClaim` checks each claim against
  the listener's *own* memory. A wrong alibi, an accusation about a room the
  listener saw the target in a different room during, or a vouch for someone the
  listener watched vent all brand the speaker with a `caught` memory — heavy
  enough to make the liar the clear top suspect. Claims flow through the same
  `remember` path as first-hand observation, so no belief is ever moved by an
  engine-side verdict.

Balance matters here: the careful personas smear without a location to check,
and only the provocateur hands out a catchable story, so the crew can identify a
traitor without the first loud liar instantly losing the match.

## Layout

```
src/
  ai/       llm.ts (transport + JSON extraction), decision.ts (intents, dialogue, fallbacks)
  game/     engine.ts (phases, perception, kills, meetings, win conditions)
            vision.ts, perception.ts, tasks.ts, dialogue.ts, deception.ts (personas,
            claims, lie-catching), persistence.ts, map.ts,
            collision.ts, navigation.ts, crewmate.ts, imposter.ts, player.ts, rng.ts
            creative.ts (generative log consoles), legacy.ts (cross-match ledger)
            link.ts (the GameLink seam: local engine vs hosted match),
            remoteLink.ts (SSE client with rejoin + interpolation),
            record.ts (finished-match record), render/renderMap.ts
  host/     main.ts (HTTP + Vite middleware + SSE entrypoint), matchHost.ts
            (autonomous loop, seats, broadcast), afkPilot.ts (plays the human
            body while nobody watches), protocol.ts (wire messages),
            store.ts (server-side ledger + history files)
  components/ GameStage.tsx, GameHud.tsx, MeetingOverlay.tsx, TaskModal.tsx,
            GameOverlays.tsx, Confessional.tsx, TouchControls.tsx
scripts/    validate-*.ts, simulate.ts, verify-llm.ts
```

## Next

Phase 7 in `PLAN.md`: Convex-backed match storage and replay (the schema stub is
in `src/convex/schema.ts`), plus auth and shareable transcripts.
