# How AI Movement Works

Movement for the AI agents is **zone-based, not pixel-based** — the model never
sees or emits X/Y. Raw coordinates are hidden from the LLM and replaced with a
small node graph it can reason about. The engine owns the physical route.

One-line summary: **the AI names a destination zone → the engine converts it to a
walkable point (console / prey / room centre) → A\* walks the sprite there with
collision and stuck-recovery.**

The main files involved:

| File | Role |
|---|---|
| `artifacts/llm-social-simulation/src/game/zones.ts` | The room/corridor node graph and zone helpers |
| `artifacts/llm-social-simulation/src/game/engine.ts` | Decision loop, view serialization, intent dispatch |
| `artifacts/llm-social-simulation/src/ai/decision.ts` | Intent schema, validation, heuristic fallback |
| `artifacts/llm-social-simulation/src/game/navigation.ts` | Nav grid, A\*, `followPath` |
| `artifacts/llm-social-simulation/src/game/crewmate.ts` | Crew movement state machine |
| `artifacts/llm-social-simulation/src/game/imposter.ts` | Imposter movement state machine |

---

## 1. The world is a node graph (`src/game/zones.ts`)

Every room and every corridor is a node. A corridor is a *hub* joining every
room it opens onto — the Skeld's west hall alone joins four — so adjacency is
just a lookup:

- `buildZoneGraph(map)` builds the graph from map data — rooms, corridors, and a
  case-insensitive `lookup` of id/name/short label to zone id.
- `zoneAtPoint(graph, map, x, y)` answers "which zone is this actor in?"
  (rooms win over corridors at their shared seam).
- `zoneNeighbors(graph, id)` returns the directly connected zones — these become
  the agent's `valid_moves`.
- `zoneByRef(graph, ref)` resolves a model-supplied id, full name or short label.
- `zonePath(graph, from, to)` is a breadth-first route through the graph.
- `standPoint(map, zone, radius)` picks a walkable point inside a zone (the
  nearest standable spot to the zone centre) to use as an A\* destination.

Raw coordinates would be hard for a language model to reason about, so they are
kept out of the prompt entirely.

## 2. Each tick, the agent gets a small menu (`engine.ts` → `buildView`)

`Engine.decide(a)` runs on a timer rather than every frame:

- Imposters re-decide roughly every 7–11s — collapsing to 2–4s while their kill
  is off cooldown, since the ready window is too short to burn on a lull. Crew
  re-decide every 10–16s.
- An agent that is already mid-task is **not** interrupted (re-pathing a crewmate
  that is standing at its console would cancel the work); the engine keeps a
  live-sabotage exception in code for the headless checks, though nothing can
  trigger a sabotage in play any more.
- An agent chasing a body to report keeps that goal until it is close enough to
  touch, then falls through so it can emit `REPORT`.

`buildView(a)` serializes what the model may know — **eyes only**: the snapshot
never contains anything outside the agent's line of sight.

- `current_location` — the human-readable zone the agent is standing in
- `valid_moves` — the **adjacent** zones it can step into
- `zones` — the full station list, so multi-hop targets still resolve
- `visible_players` / `others` — only the actors currently in line of sight;
  unseen players have no entry, no live position, room or isolation number.
  `isolation` is judged from the observer's own view, and `bodyOutstanding` is
  true only for a body the agent itself can see right now.
- plus `current_time`, `interactables`, memory, cooldowns, the agent's current
  `lead` (its strongest suspicion, name only — used by the offline heuristic to
  decide about the beacon, never serialized into a model prompt), and any
  `system_message`.

## 3. The model picks a destination zone (`src/ai/decision.ts`)

- `intentWithModel(ctx, view)` asks the configured provider for strict JSON.
- The movement primitive is `MOVE`, whose `target` is a **zone id or name**.
- `validateIntent` / `resolveZone` map that reference back onto a known node
  (case-insensitive against zone id/name); anything malformed returns `null`.
- On any failure — no key, timeout, rate limit, malformed JSON, unknown zone —
  the engine falls back to `heuristicIntent(view, rand)`, which chooses a
  destination zone from the same data, so the match never stalls.

## 4. The engine turns the zone into a physical goal (`Engine.applyIntent`)

For a `MOVE` target, `zoneByRef` resolves the zone, then:

- **Crew** (`crewmateGotoPoi` / `crewmateGotoPoint`):
  - if a sabotage is live and a repair panel is in that zone → path to the panel
  - else if the zone holds a task console the agent still owes → path straight to
    it, so arrival starts the task
  - else → walk to `standPoint` (nearest walkable point to the zone centre)
- **Imposter** (`imposterGotoPoint` / `imposterFakeTask`):
  - if the zone has a task console → walk there and fake work (alibi)
  - a named player or point → a one-shot walk to where they stand right now;
    the engine never locks onto a target (stalking was removed)
  - else → walk to `standPoint`

## 5. Physical walking (`navigation.ts`, `crewmate.ts`, `imposter.ts`)

The chosen world point is resolved with **A\*** over a navigation grid:

- `buildNavGrid(map, cell = 24, radius = 15)` — a cell is walkable only when a
  circle of `radius` fits at its centre, so paths are already clearanced.
- `findPath(grid, from, to)` — A\* with an octile heuristic; a diagonal move
  requires both orthogonal neighbours open (no corner-cutting); the returned
  waypoints are simplified by dropping any cell a clear straight run can skip.
- `followPath(map, f, dt)` / `moveAlongPath` — the entity advances along the
  waypoints using collision-aware movement, arriving within ~9px per waypoint.
- **Stuck recovery:** if an agent stops making progress for ~1.2s it re-paths
  (`recover` / `pathTo`), and gives up if the target is unreachable.
- Crew use `moveAlongPath`; imposters use the shared `followPath` — same idea.

## 6. Two special cases

- **`VENT` — removed.** No agent can enter a vent any more: the intent was
  deleted from the model vocabulary, the heuristic never emits it, and the
  idle imposter planner no longer starts a trip. The travel states
  (`seeking_vent` / `venting`) survive only so the headless renderer's deck
  check can still drive them.
- **Teleports** (meeting seating; vent travel only when a check drives it)
  relocate actors directly, so
  anything that moves an actor must land it on walkable space — the engine uses
  `seatAt` / `nearestStandable` and keeps a safety-net snap for this.

## Notes for changing movement

- The engine is plain TypeScript advanced only by `tick(dt)`; AI model calls are
  async and are applied only if the match is still `playing` and the decision has
  not been superseded (`seq === a.decisionSeq`).
- There are two movement drivers that share the A\* layer: the LLM intent path
  (`applyIntent`) and the scripted state machines in `crewmate.ts` / `imposter.ts`.
  Changing one does not change the other.
- Run the headless checks after touching anything in `src/game/` or `src/ai/`:
  `pnpm --filter @workspace/llm-social-simulation run simulate` (full matches,
  deterministic, no network) and `run check` for the validators.
