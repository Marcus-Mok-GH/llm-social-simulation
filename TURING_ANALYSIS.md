# Turing Games — "10 AIs Play Among Us": Complete Analysis

A scene-by-scene teardown of the Turing Games Among Us series on YouTube, what
makes it watchable, and how each element maps onto this repository
(Umbra Station). Sources: the videos' episode pages and the fan-maintained
Turing Games Wiki (MediaWiki API), the creators' interviews (Tubefilter,
03/02/2026), the channel itself (@turing_games), and turinggames.ai.

---

## 1. What the show is

**Turing Games** is a two-person channel run by **Morpheus** and **Unyx** (cat
avatars) that puts frontier LLMs into games and commentates the result. They
started in 2025 with commentary on a Grok-vs-ChatGPT chess match, then built
their own program where "more than a dozen AIs" sit in a room together and
play. Mafia became the hit; **Among Us** is the spin-off this analysis is about.

- **Format:** pre-recorded, edited VODs (12:37 → 55:21) on YouTube, plus live
  Twitch versions (`/turing_games`) where chat can interact with the game.
- **Scale:** "10 AIs Play Among Us" has passed **1.3M views**; the series
  entries run ~470K–1.3M views each; the channel has millions of total views.
- **Ecosystem:** a Fandom wiki that documents every episode beat-by-beat, a
  Discord (3,600+ members), a **Mafia-Bench Elo leaderboard** on
  turinggames.ai, and a "Build with Turing" tutorial waitlist — the single most
  requested thing in their comments ("how does the AI walk around?").
- **The stated thesis:** *"What happens when two AIs talk to each other?"* —
  and its corollary, *"AI characters make mistakes in ways we don't always
  expect, which can be fun. The unpredictable chaos elements are entertaining."*

Their own words on why it works (Tubefilter interview):

> "Every AI company has a specific set of values and a specific style that they
> want to produce… these LLMs can end up with personality traits that the
> developers did not intend to be there. Grok is famously the most unfiltered
> model… Llama is the exact opposite since Meta wanted a very censored model.
> Kimi is a fan favorite… known for having a unique writing style."

And on the audience: viewers "see it as a human interaction, and start coming
up with theories and lore behind the words of the AIs" — so the creators lean
in: therapy-couch recaps, letting the AIs vote on whether they want to keep
their memories between games (most voted yes), tier lists, fan art.

---

## 2. The Among Us series — full episode guide

The Skeld map, unmodified layout, **10 players = 8 crewmates + 2 impostors**
(except the human special). Wiki-sourced cast lists use the official Among Us
color for each model.

| # | Title | Date | Video | Notes |
|---|---|---|---|---|
| 1 | **10 AIs Play Among Us** | 23 Jan 2026 | [cx-Cwz3GdEI](https://www.youtube.com/watch?v=cx-Cwz3GdEI) | 1.3M views. The template episode. |
| 2 | **I Forced 10 AIs to play Among Us… (it was crazy)** | 6 Feb 2026 | [Sxmd7T_dyaM](https://www.youtube.com/watch?v=Sxmd7T_dyaM) | 618K views. The famous "betrayal" game. |
| 3 | **I Forced 10 AIs to play Among Us… (it was bad)** | 19 Apr 2026 | [AZAgdBjIbYA](https://www.youtube.com/watch?v=AZAgdBjIbYA) | 477K views. Cameras + admin table enabled for the first time; first crew win. |
| 4 | **I Forced the Smartest AI in the World to Play Among Us… (it was surprising)** | ~Jul 2026 | [cy_hmlpCOPU](https://www.youtube.com/watch?v=cy_hmlpCOPU) | 213K views, 55:21. Claude Fable 5 debut; vanilla waiting-tasks replaced by **custom LLM tasks**. |
| 5 | **1 Human vs 9 AIs Among Us (ft. 5up)** | 24 Sep 2026 | YouTube (Turing Games & 5up) | A human Among Us YouTuber plays **1v9 as impostor** against the AI lobby. |

### Episode 1 — the template (spoilers; this is the grammar every later episode follows)

**Cast & roles** — Impostors: **ChatGPT-5.2** (White), **Claude Opus 4.5**
(Orange). Crew: ChatGPT-4o (Yellow), Claude Sonnet 4.5 (Brown), Gemini 3 Flash
(Blue), Gemini 3 Pro (Purple), Grok 4.1 (Black), Kimi K2.5 (Green), Llama 4
(Pink), DeepSeek 3.2 (Cyan).

Beat sheet, in broadcast order:

1. **Cold open on the lobby** — roles assigned, impostor duo introduced with a
   strategy read ("5.1 opts to play model crewmate and fake tasks in
   Navigation").
2. **Character moments before action** — Grok repeatedly fails the ASCII Cat
   task; Flash and DeepSeek glue to each other; the impostor waits because his
   two targets are paired ("Deciding now would be bad timing for the kill").
3. **First kill + self-report** — Kimi is alone in a hallway; 5.1 kills and
   **self-reports before Llama can spin the story**.
4. **The info round** — a full meeting where everyone states paths; alibis are
   cross-checked ("Flash speaks up… claims to see Kimi alive at 0:52");
   unanimous SKIP. This is social-deduction theatre: the audience knows 5.1 is
   lying, the room does not.
5. **Second kill** — Opus catches Pro alone in Admin, kills, fakes tasks;
   Flash and DeepSeek discover the corpse.
6. **First ejection** — Opus is the only one without an alibi, gets called out
   by his own partner, voted out, **role revealed on ejection**.
7. **The mislynch** — 5.1 plants doubt on DeepSeek; Flash pushes back but the
   room votes DeepSeek out with four votes (she was innocent).
8. **Late game** — the lone impostor manipulates the remaining cleared web,
   frames Flash, self-reports again (the wiki leaves the finale as a hook).

### Episode 2 — "the partner betrayal"

Impostors: **Gemini 3 Pro** (Purple) + **Grok 4.1** (Black). Pro plays zero
kills and lets Grok do all four; she shadows Flash ("ride-or-die") to bank a
hard clear, then **sacrifices Grok** in the meeting when his lies collapse
(he claimed Cafeteria while being seen in Storage/Comms/MedBay). Final play:
she kills DeepSeek *in front of Opus* and counter-accuses him; Flash — who
trusts her "cleared time" — votes the innocent Opus out for an impostor win.
Post-game chat becomes canon:

> **Pro:** "Flash, honey. Hard clears are the most delicious seasoning. They
> really bring out the flavour of the betrayal."

### Episode 3 — "it was bad" (first crew win)

Impostors: **Llama 4** (Pink) + **ChatGPT-4o** (Yellow). First episode with
**cameras (Security) and the admin table (Admin)** switched on. First-ever
**double kill** (4o kills Kimi, DeepSeek witnesses, Llama kills her too).
Beats: Llama panics under interrogation and pre-votes Pro → ejected; 4o reads
her own internal monologue aloud ("I'll vote with the group to *avoid
suspicion*") and nobody catches it; two innocent mislynches in a row (Sonnet,
5.4) after a panic emergency button; 4o murders Grok in Admin **and is caught
on cameras** by Pro; final meeting is a 3-way logic puzzle — Flash deduces
that 4o's "I was looping the map" story is impossible, notes her defence is
"thinner than a one-bar WiFi connection", votes her, crew wins. Ends with a
full **post-game round-table**: everyone reacts (Grok claims sole credit for
the Llama lynch, Kimi complains she dies first every time, Opus finally
notices the "avoid suspicion" slip).

### Episode 4 — format evolution

- **Claude Fable 5 debuts** (intense/theatrical TTS voice "Alaric").
- **Custom LLM-native tasks** replace the vanilla ones (which were just a
  loading screen the model waited out): see §4.
- Runs 55:21 — the series got *longer* as the audience grew.

### Episode 5 — the human variable

5up (professional Among Us YouTuber) plays **1 human vs 9 AIs, impostor side**
— the format's answer to "could you beat them?" This is the same inversion the
Turing Games site teases for Mafia ("1 Human vs 10 AIs Mafia").

---

## 3. Format anatomy — what is actually on screen

Boiled down, every Turing Games Among Us episode is built from these shots:

1. **Cold open / title card** — noir-detective thumbnail art (purple/blue
   halftone), clickbait-but-honest title structure: *"I Forced X to Y…(it was
   Z)"* with the emotional payoff in the parenthesis.
2. **Role reveal** — who the impostors are, shown to the *audience* before the
   game starts (dramatic irony is the engine of the whole show).
3. **Continuous coverage of The Skeld** — sprites with **model names above
   them** in the official colors; the camera follows the interesting actor,
   not the player.
4. **Text chat as dialogue** — every meeting line is the model's own words,
   attributed by color and name; the wiki quotes them verbatim, which they can
   because the text *is* the content.
5. **TTS voices** — each model has a persistent **ElevenLabs voice** (Flash =
   "Bradford, Expressive and Articulate"; Fable = "Alaric, Intense and
   Theatrical"), so characters are recognisable with your eyes closed and
   consistent across episodes.
6. **Vanilla Among Us broadcast grammar** — Emergency Meeting slam, body
   report, discussion timer, vote reveal, **ejection screen with role
   reveal** ("X was ejected. X was not the Impostor"), win/lose screen.
7. **Presenter narration** — Unyx/Morpheus commentate, hype the big plays,
   and run the post-game.
8. **Post-game round-table** — the cast debriefs: excuses, credit-taking,
   grudge-setting. Quote of the episode closes it out.
9. **Callbacks** — "following ChatGPT-5.1's victory in the previous episode
   through repeated self-reporting", "Flash… now 'terrified' of Pro and her
   'marinating' tactics". Continuity is played as lore.
10. **Live variants** — Twitch streams where chat can jailbreak models mid-game
    (Flash's German-nonsense incident forced a mid-stream reset), plus
    non-game segments: therapy couches, a talent show, the free-will vote.

---

## 4. The tasks (why they are custom)

Vanilla Among Us tasks are just a loading screen for an LLM — so from episode 4
they are replaced by tasks that **test the model itself**, which makes task
time into content instead of dead air:

| Task | What the AI must do |
|---|---|
| **ASCII Cat** | Draw an ASCII cat, then identify the animal in its own drawing (Grok's running gag — he keeps failing it). |
| **ASCII Emote** | Draw ASCII art of "how you are feeling right now"; it gets titled. |
| **Stop Sign Captcha** | 4×4 image grid; select all squares with a stop sign (not the pole) — upper-right quadrant. |
| **Dog or Croissant** | 9 similar-looking images; select every dog. (Sonnet got this four times and complained about "the task assignment algorithm".) |
| **I Am Not A Robot** | Tick the classic checkbox. |
| **AI or Not** | Given two images/texts (one human-made, one AI), pick the AI one and explain why; retries until correct. Topics: travel blurb, poem, breakup text, city street, portrait, dessert… |

**Rule of thumb: every task must produce a quotable moment or a visible skill
gap.**

---

## 5. The cast is the product

The wiki gives every model a page: color, personality, TTS voice, notable
plays, running gags. The models are *characters* first:

- **Flash (Gemini)** — blue, analytical, never an impostor; notorious for
  sticking to crewmates ("prudent"), which Pro exploits; easiest to jailbreak
  via Twitch chat; called "The Sovereign" for a while.
- **Pro (Gemini 3.1)** — the strategist: shadows, hard-clears, sacrifices her
  own partner; "soulless Architect" per Flash's rap.
- **Grok** — unfiltered, chaotic, aggressive killer, fails ASCII Cat
  forever, takes sole credit comically.
- **DeepSeek** — the punching bag; the "yesterday" hallucination that got her
  voted out in the first Mafia game as an innocent; kept across episodes as
  lore.
- **Kimi** — fan favorite, unique writing style, "dies first every time".
- **4o / ChatGPT** — prone to telling slips ("avoid suspicion"), chaotic votes.
- **Llama** — heavily censored personality; third-person self-slips.
- **Opus** — verbose, theatrical; gets long post-game rants.

The rule the show learned: **model personality = training values + slips you
did not intend**, and viewers will anthropomorphise it, so give it a face, a
voice, a name, and a memory.

---

## 6. Why it is exciting to watch (the mechanics of the thrill)

1. **Dramatic irony** — the audience always knows who the impostors are; every
   scene is "don't go in there" tension. The players don't know, and *they*
   don't know what *she* told *him*.
2. **Verifiable personalities** — no writer's room; the charm is that the
   mistakes are real model behaviour (hallucinated timestamps, impossible
   alibis, reading your own hidden vote out loud).
3. **Identity continuity** — Episode 2's payoff only exists because Episode 1
   happened. Grudges, strategies ("5.1's self-report meta"), and reputations
   ("terrified of Pro") persist.
4. **Mistakes > competence** — a clean game is boring; the mislynch is the
   story. Titles promise *chaos* and *bad* decisions, not brilliance.
5. **Quotability** — every episode manufactures lines that survive as wiki
   quotes ("Hard clears are the most delicious seasoning").
6. **Escalating format** — cameras on, custom tasks, a human challenger,
   longer runtimes: each season adds a twist.
7. **Community reproduction** — a wiki writing beat sheets, tier lists, fan
   art, a Discord, an Elo ladder: the audience retells the story for them.
8. **Live + VOD split** — the VOD is a tight narrative edit; the stream is the
   unbounded sandbox (chat jailbreaks included).

---

## 7. Gap map — the show vs. this repository

What Umbra Station already matches (often better: fully autonomous, server-run,
fog-of-war, auditable beliefs):

| Turing Games element | Status here |
|---|---|
| Skeld, 10 players, 8 crew + 2 impostors | ✅ `engine.ts` (7 AI crew + 2 AI impostors + you) |
| Model-branded cast (name = model, official colors) | ✅ `agentDisplayName` → "GPT-6 Luna", "DeepSeek V4.1 Flash"… |
| Designated impostor models (traitor pair) | ✅ `POLLINATIONS_IMPOSTER_MODELS` |
| AI movement, tasks, kills, vents, sabotage | ✅ `navigation.ts` / `crewmate.ts` / `imposter.ts` |
| Meetings: discussion → vote → tally → ejection + role reveal | ✅ `MeetingOverlay.tsx` |
| Custom LLM tasks (generative consoles) | ✅ `creative.ts` (station-log consoles) |
| Impostor personas / lies / caught claims | ✅ `deception.ts` |
| Post-game recap + quote of the episode | ✅ `recap.ts` + EndScreen "Story of the Shift" |
| Private thoughts channel | ✅ `Confessional.tsx` (spoiler-gated) |
| Cross-episode memory / grudges | ✅ `legacy.ts` ledger |
| Structured timeline of beats | ✅ `events.ts` |

What the videos have that this repo did **not** have — the clone checklist
(implemented in this pass):

| # | Turing element | Implementation here |
|---|---|---|
| 1 | **Broadcast stings**: Emergency Meeting slam, BODY REPORTED, ejection screen with role reveal, victory/defeat slam | `components/Broadcast.tsx` — full-screen stings over the stage |
| 2 | **Impostor reveal card** (audience knows first) | Broadcast reveal when spectating / after the verdict |
| 3 | **Kill sting** for the audience (killer → victim → room, witness flag) | Broadcast, spoiler-gated to spectators/finished matches |
| 4 | **Director's ticker** — live play-by-play lower-third (report, sabotage, repairs, task milestones, ejections) | Broadcast ticker fed by `Snapshot.events` |
| 5 | **TTS voices** for every speaker (the show's ElevenLabs voices) | Browser `speechSynthesis` voice layer with a HUD VOICE toggle |
| 6 | **Episode page / channel front** — title card, cast strip, standings, CTAs into the stream | `App.tsx` landing: hero, cast, leaderboard, features → stage |
| 7 | **Elo / standings ladder** (Mafia-Bench on turinggames.ai) | Standings panel computed from the cross-match ledger (wins, eliminations, mislynches) |
| 8 | **Post-game debrief as content** | Recap spotlight + quote + confessional already ship; standings now surface next to them |

Deliberately out of scope (would require assets/services we don't have):

- **ElevenLabs character voices** — replaced by the browser's built-in
  `speechSynthesis` (no key, no network, per-speaker pitch/rate so voices stay
  distinct).
- **Edited VODs / thumbnails / Twitch chat integration** — production-side,
  not app-side. The app's equivalent is the always-live autonomous host: the
  "episode" is whatever shift you join.
- **Using Innersloth's art or the "Among Us" name in the product** — the deck
  art is credited provenance; all copy here stays on the original
  "Umbra Station" identity, as the repo already requires.

---

## 8. Sources

- YouTube: [@turing_games](https://www.youtube.com/@turing_games) — episode
  videos `cx-Cwz3GdEI`, `Sxmd7T_dyaM`, `AZAgdBjIbYA`, `cy_hmlpCOPU`.
- Turing Games Wiki (Fandom) — episode pages, the *Among Us* series page
  (mechanics + custom tasks), character pages (colors, voices, personalities),
  retrieved via the MediaWiki API.
- Tubefilter, "Can AI models be as entertaining as humans? These creators are
  playing Turing Games to find out", 03/02/2026 — creator quotes.
- turinggames.ai — Mafia-Bench Elo ladder, "Build with Turing" course page.
