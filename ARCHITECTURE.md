# Architecture Review — State, Roles, Player Status & Communication

A working map of how Umbra Station (the `artifacts/llm-social-simulation`
artifact) manages **game state**, assigns **roles**, tracks **alive/dead player
status**, and handles **communication** — followed by a proposed architectural
approach for integrating new features into those four subsystems.

Read alongside `MOVEMENT.md` (movement/AI action pipeline) and
`artifacts/llm-social-simulation/PLAN.md` (feature roadmap). This document is
the state/social counterpart to those.

> **Scope note.** This pass is the *understanding + design* pass of its thread:
> the concrete feature list for "the requested features" is not restated here.
> The proposal is therefore written as an extension framework with named hook
> points, plus concrete worked integrations for the most probable directions
> (a human seat, ghost/dead comms, new roles, multiple viewers). Any feature can
> then be scoped against the same four subsystems.

---

## 1. Repository & module map

Single pnpm workspace. The app deploys from `artifacts/llm-social-simulation/`;
everything else (`lib/*`, `isolate/`, `dist/`) is workspace scaffolding or build
output. All game code is under `src/`.

| Concern | File | Role |
|---|---|---|
| **Game state / state machine** | `src/game/engine.ts` | The whole match: phases, perception, kills, sabotage, meetings, votes, win conditions. 3301 lines, plain TS, no React, no wall clock. |
| State types | `src/game/engine.ts` | `Actor`, `Snapshot`, `Phase`, `Winner`, `Body`, `MeetingState`, `ChatMessage`, `ConfessionalEntry`, `ThoughtEntry` |
| | `src/game/player.ts` | The player avatar (`Player`) + movement |
| | `src/game/crewmate.ts` / `imposter.ts` | The two AI movement/state-machine drivers |
| | `src/game/tasks.ts` | Task assignment, task bar math, minigame kinds |
| | `src/game/events.ts` | Structured append-only match timeline (`MatchEvent`) |
| **Roles** | `src/game/perception.ts` | `Role = "crew" \| "imposter"`; `Mind`.allies |
| | `src/game/engine.ts` | `buildRoster`, `drawSeatModels`, `pickSeatModels`, `modelFor`, `makeActor` |
| | `src/game/deception.ts` | Traitor personas + structured meeting claims (`accuse`/`vouch`/`alibi`) |
| **Alive / dead status** | `src/game/engine.ts` | `Actor.alive`; `kill()`, `resolveVote()`, `enterSpectator()`, `living()`, `checkWin()` |
| **Communication** | `src/game/dialogue.ts` | `Statement` (line + private `thinking` + structured `claim`) |
| | `src/ai/decision.ts` | Fog-of-war `WorldView` serialization → `Intent` / meeting `Statement` |
| | `src/ai/llm.ts` | Transport, rate gate, JSON extraction, per-agent `LlmConfig` |
| | `src/game/perception.ts` | The belief model — the only thing a claim/observation can move |
| | `src/game/creative.ts` | Generative station-log entries (public write channel) |
| | `src/game/recap.ts` | Pure narrative from `events` (end screen) |
| **Transport (client ↔ host)** | `src/host/protocol.ts` | `ServerMsg` (SSE) / `ClientMsg` (POST) wire types |
| | `src/host/matchHost.ts` | Owns the engine server-side, ticks it, seats viewers, broadcasts |
| | `src/host/main.ts` | HTTP + SSE + Vite middleware |
| | `src/host/afkPilot.ts` | Plays the human body when the seat is free |
| | `src/game/link.ts` / `remoteLink.ts` | `GameLink` seam: `LocalGameLink` vs `RemoteGameLink` |
| | `src/game/legacy.ts` / `persistence.ts` | Cross-match ledger + match history |
| **Presentation** | `src/App.tsx`, `src/components/*` | Landing, stage, HUD, meeting overlay, broadcast, confessional |

**Invariants worth preserving (documented in `replit.md`):** one `tick(dt)`
advances the world; the engine never touches React or `Date.now()` for game
logic; every model call has a validated shape and a heuristic fallback; votes
come from the belief model, never the model; the match lives on the server.

---

## 2. Game state management

### 2.1 The engine is the single source of truth

`GameEngine` (`src/game/engine.ts`) owns every piece of match state:

- **Identity/actors** — `actors: Actor[]`. Index 0 is always the human
  (`key: "player"`, `isPlayer: true`); AI crew are `crew:0..n`; AI imposters
  are `imp:0..n`. Each `Actor` carries `role`, `alive`, `zoneId`, its movement
  `entity` (`Player | Crewmate | Imposter`), its `mind` (belief model), its
  per-agent `cfg` (`LlmConfig`), its `tasks`, and its cooldowns
  (`killCooldown`, `sabotageCooldown`, `fixUntil`).
- **Phase** — `Phase = "briefing" | "playing" | "meeting" | "ended"`.
  `tick()` early-returns during `briefing`/`ended`; `meeting` is a separate
  sub-loop (`tickMeeting`); `playing` runs the full simulation.
- **World** — `bodies`, `sabotage {kind, secondsLeft, fixPoiIds, fixProgress}`,
  `messages` (chat), `events` (timeline), `log` (short HUD lines).
- **Presentation state** — `thoughts`, `rawJsons`, `stationLog`, `confessional`,
  `analystView`, `spectator`.
- **Cross-match state** — `legacy` ledger, `grudgesByKey`, `ejections`.

The engine is authoritative and deterministic given `(seed, dt)`; the
`MatchHost` varies the seed per shift.

### 2.2 Tick pipeline (`engine.tick`)

`playing` tick order (line ~2960):

1. Move the player (normalized input, collision-aware).
2. Reveal fog around the player; move living crewmates and imposters (imposters
   only vent when unobserved).
3. `refreshZones()` — recompute `zoneId` from position for living actors.
4. Per living actor: decay cooldowns; if `time >= nextDecisionAt` call
   `decide(a)`; else if an urgent interaction is in reach, schedule a decision
   ~0.5s out; snap any actor accidentally left in a wall (`nearestStandable`).
5. AI task credit (crewmate consoles → shared task bar + station log); imposter
   faked tasks → cover-story log entries.
6. `syncTaskBudget()`, `perceive(dt)`, `updateSabotage(dt)`, `aiReportChecks()`.
7. Overtime (`OVERTIME_AT`) softens kill cooldowns; `MATCH_LIMIT` ends the
   shift on task-bar progress; then `checkWin()`.

Meeting phase runs a small state machine inside `MeetingState.stage`:
`discussion` (60s, one speaker turn every ~2.2–4.6s, fair rotation via
`spoken`/`lastSpeaker`) → `voting` (20s, AI votes scheduled per actor via
`voteAt`) → `tally` (6s), then `finishMeeting()`.

### 2.3 Server authority & snapshots

- `MatchHost` (`src/host/matchHost.ts`) constructs one `GameEngine`, calls
  `pump(dt)` on a timer, auto-begins in spectator mode after `autoBeginMs`, and
  chains the next shift after `intermissionMs`. It folds each finished match
  into the ledger and history even with zero viewers.
- Viewers attach over SSE; `buildState()` projects `engine.snapshot()` +
  `RenderWire` + `rosterOf(engine)` + an encoded fog raster into a `StateMsg`
  at 10 Hz.
- `LocalGameLink` (offline fallback / first render) drives the same `GameLink`
  surface as `RemoteGameLink`. Presentation only ever sees a `GameLink`.

**Implication for new features:** any new state must be added (a) to the engine,
(b) to `Snapshot` and/or `RenderWire`, (c) to the wire projection in
`MatchHost.buildState`, and (d) to the `GameLink` surface if the client drives
it. That four-step path is the cost of every stateful feature.

---

## 3. Roles

### 3.1 The role model today

- `Role = "crew" | "imposter"` is defined once in `src/game/perception.ts` and
  reused everywhere (`Actor.role`, `Mind.role`, `WorldView.self.role`,
  ejection records).
- **Casting is per-shift and random.** `buildRoster()` seats everyone around the
  meeting table, then `pickSeatModels(imposterCount)` → `drawSeatModels(pool,
  count, avoid, seed)` picks imposters from the provider's model pool, avoiding
  last shift's pair. Crew and imposter seats draw from disjoint lists, so a
  model is never both sides in one match.
- `AI_CREW = 4`, `createImposters(map, playerIsImposter ? 1 : 2)` — so a match
  is 4 AI crew + 2 AI imposters + the (spectating) player = 7 actors.
- Agents are *named* for the model that runs them (`agentDisplayName` /
  `modelNameOf`); the cross-match identity is the model name (`identityOf`).
- Persistence uses `DeceptionStyle` (`wire-puller` / `provocateur` /
  `confidant` / `ghost`) assigned per imposter via `styleForIndex`.
- `Mind.allies` holds the imposter pair; `bump()` and `topSuspect()` never move
  suspicion toward an ally.
- Win conditions are role-count arithmetic in `checkWin()`:
  `imps === 0` → crew win; `imps >= crew` → imposter win; task bar complete →
  crew win; `MATCH_LIMIT` → judged on task progress.

### 3.2 Where role behavior is implemented

Roles are **not** a class hierarchy — they're branches on `role`/`kind`:

- Movement: `crewmate.ts` vs `imposter.ts` state machines.
- Decisions: `ai/decision.ts` `heuristicIntent()` branches on `view.self.role`;
  prompt templates differ by role.
- Interactions: `engine.buildInteractables()` offers different options per role;
  `executeInteraction()` validates (`KILL` requires imposter + cooldown +
  range + no witnesses; `TASK` requires crew + an owned, undone task; etc.).
- Meeting: `fabricateClaim` (traitor, persona-flavored) vs `crewClaim`
  (evidence-driven); `chooseVote()` differs by role.
- Vision/perception: shared, but `visible()` and `witnesses()` check role.

**Implication:** adding a role today means editing many `role === "imposter"`
branches across the engine. A role registry is the natural structural fix
(§7.2).

---

## 4. Player status — alive / dead

### 4.1 The single flag

`Actor.alive: boolean` is the one source of truth. It is read by:
`living()`, `perceive()`, `tick()` (skip dead actors), `checkWin()`,
`killTargetFor()`, `witnesses()`, `sabotageHolders()`, `buildInteractables()`,
`currentMeetingView()` (speaker list), `snapshot()`, and `MatchHost.buildState`.

### 4.2 Every transition

| Transition | Code | Side effects |
|---|---|---|
| Killed by an imposter | `kill()` | `victim.alive = false`; crew entity teleported to `-9999`; `crewmateHalt`; body pushed to `bodies`; witnesses get a `kill` memory; `killCooldown`; `checkWin()` |
| Ejected by vote | `resolveVote()` | `ejected.alive = false`; entity halted & teleported; `ejects++`; ejection banked for next-shift grudges; `eject` memory for the living; `checkWin()` |
| Player leaves to spectate | `enterSpectator()` | `spectator = true`; **player actor `alive = false`** (reuses the dead path); keys/touch/task cleared; `syncTaskBudget()`; "watch with full vision" |

Death is therefore *not* a bespoke state — it is the same `alive = false` flag,
with the corpse living in `bodies` and the actor skipped everywhere. The
spectator flag is **orthogonal**: `spectator` controls fog/camera/input, while
`alive` controls participation.

### 4.3 Death is surfaced through four separate paths

The UI learns about death via **four independent projections**, which is the
main fragility in this subsystem:

1. `Snapshot.playerAlive` (+ `Snapshot.alive: {crew, imposter}`) in `engine.ts`.
2. `RenderWire.playerAlive` built in `MatchHost.buildState()`.
3. `LocalGameLink.frame()` filters `crewmates`/`imposters` by an alive set.
4. `RenderWire.crew` / `RenderWire.imp` are serialized wholesale and filtered
   client-side in `GameStage`.

There is **no** dead/ghost communication channel: a dead actor is simply absent
from `living()`, so it cannot speak, vote, or be spoken to. There is also no
"disconnected" status — the AFK pilot (`host/afkPilot.ts`) plays the body while
the seat is free.

**Implication:** re-introducing a human seat, adding ghost chat, or showing a
"disconnected" state all touch the `alive` flag, so it should become an explicit
status enum with one transition function (§7.3).

---

## 5. Communication

Communication exists on several distinct lanes with different audiences. This
separation is a core design property (auditable beliefs; dramatic irony for the
audience) and should be *extended*, not flattened.

### 5.1 In-engine public channels

| Lane | Type / field | Audience | Written by |
|---|---|---|---|
| Meeting chat | `ChatMessage` (`kind: statement \| system \| player`) in `engine.messages` | all living actors + viewers | `say()`, `system()`, `speak()`, `playerSay()` |
| System log | `engine.log` (ring, 6) | HUD | `note()` |
| Station log | `StationLogEntry` in `engine.stationLog` | public; remembered by **every** agent (`kind: "log"`) | `writeLogEntry()` (creative consoles) |
| Structured timeline | `MatchEvent[]` in `engine.events` | derived surfaces (broadcast, recap) | engine as things happen |
| Roster/state | `Snapshot`, `RenderWire`, `ActorRow[]` | viewers | `snapshot()`, `buildState()` |

### 5.2 Private / spoiler channels

| Lane | Type / field | Audience | Notes |
|---|---|---|---|
| Thought feed | `ThoughtEntry` in `engine.thoughts` | spectators | every decision + meeting line; carries raw JSON for model calls |
| Raw replies | `RawJsonEntry` in `engine.rawJsons` | spectators | exactly what the provider returned |
| Confessional | `ConfessionalEntry` in `engine.confessional` | spoiler-gated audience | `action` vs private `thought`; `concealing` true for traitors |

### 5.3 The belief model (what communication *does*)

`src/game/perception.ts` is the arbiter: `remember(mind, entry)` is the **only**
thing that moves suspicion, via `KIND_WEIGHT` (`kill 0.95`, `vent 0.6`,
`flag 0.35`, `accuse 0.1`, `vouch -0.18`, `caught 0.35`, neutral for
`sighted`/`body`/`task`/`report`/`eject`/`log`). Meetings route public claims
through `applyClaim()` → `judgeClaim()` (in `deception.ts`), which checks a
claim against the *listener's own* sighting memory; a contradiction becomes a
`caught` memory. Votes are computed from `topSuspect()` scores, never generated
by a model. This is what makes "what an agent says" auditable against "what it
believes."

### 5.4 Model I/O

- `ai/decision.ts` builds a **fog-of-war** `WorldView` (`current_location`,
  `valid_moves`, `zones`, `visible_players`, `others`, `interactables`,
  `history`, `meeting_history`, `your_goal`, `last_seen`, `your_personality`,
  `your_grudges`, …). No live position of an unseen actor, no raw coordinates,
  no suspicion score ever reaches the model.
- The model's whole vocabulary is `MOVE` (target = zone/actor/object id) and
  `INTERACT` (`TASK | KILL | REPORT | EMERGENCY`, validated by
  `validateIntent`). `VENT`/`SABOTAGE` were removed; `FIX` survives only for
  headless checks.
- Meeting lines come back as a `Statement` (`line` + private `thinking` +
  optional structured `claim`); `statementWithModel` / `fallbackStatement` feed
  `speak()`.
- `ai/llm.ts` owns transport, `RequestGate` (rate limit), JSON extraction, and
  `LlmConfig` per agent; every path falls back to the heuristic.

### 5.5 Transport (client ↔ host)

SSE fork with `host/protocol.ts`:

- Server → client: `{type:"hello"}` (session, seat, matchId, first state,
  history), `{type:"state"}` (snapshot + render + roster + optional fog runs),
  `{type:"record"}`.
- Client → server (`ClientMsg`): `key`, `touch`, `clear`, `begin`, `interact`,
  `kill`, `report`, `sabotage`, `say`, `vote`, `advance`, `task`, `spectate`,
  `analyst`, `restart`.
- `MatchHost.handleAction()` splits **view-scope** controls (anyone) from
  **seat-only** controls (`if (this.playerSession !== session) return`).

**Implication:** a new message type must be added to `ClientMsg` + the
`handleAction` switch, and any new server→client data to `ServerMsg` +
`buildState` + `remoteLink` + `GameLink`.

---

### 5.6 End-of-match reveal (implemented)

When the match ends, `endMatch()` calls `publishReveal()`, which (a) sets the
engine's `reveal: ImposterReveal[] | null` (surfaced on `Snapshot.reveal` for the
gallery), (b) announces the imposters on the `system` channel, and (c) writes a
`reveal` memory into **every** AI's `Mind` — the dead included — naming each
imposter. `reveal` carries zero `KIND_WEIGHT`, so it is knowledge rather than
evidence and can never move a belief. `engine.revealedAgents` reports how many
AI agents were informed, and `scripts/simulate.ts` asserts the reveal covers
every imposter and reaches every AI.

## 6. Risks / friction observed

1. **Four parallel death projections** (§4.3) — easy to desync a new surface.
2. **Role logic is scattered branches** on `role === "imposter"` (§3.2) —
   adding a role or ability is cross-cutting.
3. **Boolean duality** — `alive` + `spectator` + (implicit ghost) is an
   under-specified state space; `enterSpectator()` overloads "dead" to mean
   "left", which already causes a semantic mismatch (`playerAlive === false`
   but the entity is alive on the deck).
4. **Lanes are implicit.** Communication channels are separate arrays with
   ad-hoc audience rules scattered across `snapshot()`, `buildState()`,
   `GameStage`, and `Confessional`/`Broadcast`. Adding a channel (ghost chat,
   DMs) means touching each.
5. **No extension seam for roles/abilities.** `InteractionType` and the intent
   validator are closed lists; a new ability needs edits in `decision.ts`,
   `engine.buildInteractables`/`executeInteraction`, prompts, and fallbacks.
6. **Docs vs code drift.** README/TURING_ANALYSIS say "seven AI crew + you" in
   places while `AI_CREW = 4`; the shipped UI is spectate-only. The docs should
   be reconciled as part of any feature pass.

---

## 7. Proposed architectural approach

Goal: make the four subsystems additive. Keep the engine pure and authoritative;
introduce explicit abstractions for status, roles, and channels; expose them on
the existing `GameLink`/protocol seams.

### 7.1 Phase A — Formalize player status

> **Status: implemented.** `ActorStatus` (`alive` / `dead` / `spectator` /
> `disconnected`) plus `isParticipating()` and the single
> `GameEngine.setActorStatus()` transition now live in `src/game/engine.ts`;
> `Actor.alive` and `GameEngine.spectator` are derived, and `ActorRow` /
> `RenderWire` carry `status` for the client. `kill`, `resolveVote` and
> `enterSpectator` all route through the transition, and the headless checks
> (`simulate`, `validate:host`, `validate:spectator`) remain green.

- Replace the `alive: boolean` + `spectator: boolean` pair with an explicit
  `ActorStatus = "alive" | "dead" | "spectator" | "disconnected"` (keep a
  derived `alive` getter for compatibility so existing reads keep working).
- Add one transition function `setActorStatus(actor, next, reason)` that owns
  every side effect currently duplicated across `kill()`, `resolveVote()`, and
  `enterSpectator()` (halt entity, teleport, clear input/task, `syncTaskBudget`,
  `checkWin`).
- Derive the four death projections (§4.3) from that one status so new surfaces
  cannot desync; add a `status` field to `RenderWire`/`rosterOf` rather than
  inferring from `alive`.
- *Enables:* a real human seat, ghost/dead participation, a "reconnecting"
  status, per-actor spectator flags.

### 7.2 Phase B — Role & ability registry

> **Status: the thread's Phase B was scoped to the *meeting speaker token*, not
> this role registry.** Delivered in `src/game/engine.ts`: the private
> `MeetingState` was promoted to an exported first-class `Meeting` interface
> carrying a `SpeakerToken` (`key`/`name`/`seq`/`since`); the discussion grants
> exactly one token at a time and only the holder can add a line, so no two AI
> lines can be in flight (`SPEAKER_DEADLINE` frees a stalled model reply). The
> snapshot reports the holder as `MeetingView.speaking`, and the engine exposes
> `speakerTurns` / `speakerViolations` / `speakerOverlaps` for the harness. The
> role registry described below is still outstanding.

- Introduce `interface RoleDef { id; name; winCheck?; interactables?;
  intentTypes?; promptBrief; heuristicIntent?; votePolicy?; claimPolicy?; }`
  and a `ROLES` registry keyed by `Role`.
- Migrate the existing `crew`/`imposter` behavior behind the registry
  (mechanical refactor, no behavior change), so engine code calls
  `role.def.<hook>` instead of branching on the literal.
- Extend `Role` to an open union (or keep `crew`/`imposter` plus modifiers like
  `jester`, `engineer`) and route `INTERACTION_TYPES` through the registry so
  the intent validator and prompts stay in sync.
- Preserve the invariant that role casting runs on its own deterministic RNG
  stream (`drawSeatModels`) so `scripts/simulate.ts` stays reproducible.
- *Enables:* new roles, role abilities, asymmetric win conditions (jester,
  detective), per-role vision.

### 7.3 Phase C — Communication channels as first-class

> **Status: implemented (ghost chat).** `ChannelId` / `ChannelDef` / `CHANNELS`
> and the engine's single `publish(channel, msg)` write path now live in
> `src/game/engine.ts`; `ChatMessage` carries a `channel`, and `Snapshot` (see
> `src/game/engine.ts`)
> exposes `channels`, `ghostChat`, `ghostMessages` and the active `ghostSpeaker`.
> The `ghost` channel (audience `"dead"`, inert to beliefs) is spoken by dead
> AIs on a strict one-voice-at-a-time turn token (`GHOST_TALK_TIME` /
> `GHOST_QUIET_TIME`), rendered by `src/components/GhostChat.tsx`. Full migration of
> `say`/`system`/logs onto descriptors is partial: `say`/`system` are published
> with their channel id, while the confessional/thought feeds remain dedicated
> arrays.

- Introduce a `Channel` descriptor: `{ id, audience: "public" | "spectators" |
  "role" | "actors", retention, spoiler }`, and tag every message record
  (`ChatMessage`, `ThoughtEntry`, `ConfessionalEntry`) with `channelId`.
- Provide a single `publish(channelId, from, payload)` API on the engine and
  route `say`/`system`/`stationLog`/`confessional` through it (behavior
  preserved).
- Add a `channels` section to `Snapshot`/`ServerMsg`, and make the client render
  from the descriptor instead of hard-coded arrays.
- Encode claim/belief effects per channel (only meeting claims go through
  `applyClaim`; ghost chat must not move living beliefs).
- *Enables:* ghost/dead chat, private DMs/alliances, narrator/commentary channel,
  per-viewer filtered streams.

### 7.4 Phase D — Seat & authority extension (only if multi-seat is in scope)

- Generalize the single `playerSession` in `MatchHost` to a `seats` map, with a
  `Seat` carrying its own session, status, and controlled `actorKey` (or none
  for spectators). Keep `afkPilot` as the "no human" controller per seat.
- Add `ClientMsg` variants (`claimSeat`, `leaveSeat`, `ghostSay`) and extend
  `handleAction`; extend `hello` with the seat's actor key.
- Keep local mode working by having `LocalGameLink` implement the same surface.

### 7.5 Verification strategy (extend existing harness)

The repo already verifies behavior headlessly; new features should ride the
same rails rather than inventing new tooling:

- `scripts/validate-host.ts` — seat rejoin, autonomous ticking, ledger/history.
  Extend with multi-seat/status-transition assertions.
- `scripts/simulate.ts` — full deterministic matches. Extend to assert a new
  role's win condition and a new channel's effects.
- `scripts/validate-ai.ts` — the intent/statement validators; extend for new
  interaction types.
- `scripts/validate-deception.ts` / `validate-watchability.ts` — claim judging
  and channel gating.
- `scripts/validate-ui.tsx` — React tree renders; extend for new overlays.
- Keep `pnpm run check` green (typecheck + all validators + simulate).

### 7.6 Suggested sequencing

1. **Documentation reconciliation** (§6.6) — cheap, removes ambiguity before
   touching behavior.
2. **Phase A (status)** — smallest, highest-leverage; unblocks seat + ghost
   features and de-risks the four death projections.
3. **Phase C (channels)** — mainly additive; delivers ghost/DM/narrator value
   without touching role logic.
4. **Phase B (roles)** — larger mechanical refactor; do it behind a
   behavior-preserving test pass before adding any new role.
5. **Phase D (seats)** — build on A+C; explicitly gated on whether
   multi-viewer play is in scope.

Each phase should land as its own PR-sized change with `pnpm run check` (and
`pnpm run simulate`) green, so the deterministic replay remains the regression
net for the whole simulation.

---

## 8. Verification of this document

This pass changed **no code** — it adds this document only. The claims above
were checked against the source at commit `c9c14dc` ("Make imposters different
every match") by reading `engine.ts`, `player.ts`, `perception.ts`,
`deception.ts`, `dialogue.ts`, `ai/decision.ts`, `ai/llm.ts`, `host/protocol.ts`,
`host/matchHost.ts`, `game/link.ts`, and the repo's own `README.md` /
`replit.md` / `PLAN.md` / `MOVEMENT.md`. No typecheck or simulation run was
required since no source changed; the next feature pass should begin by running
`pnpm --filter @workspace/llm-social-simulation run check` to confirm a clean
baseline.
