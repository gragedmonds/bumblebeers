# Bumblebeers — adult slo-pitch analytics + planning

The Bumblebeers are an adult slo-pitch softball team in Whitby, Ontario. This
repo contains:

1. **A Python data pipeline** that scrapes the team's GameChanger account and
   produces stat aggregates, BMBL+ composite rankings, and a snapshot JSON
   payload.
2. **A Next.js 16 web app** (`web/`) deployed to Vercel that presents the
   stats with five surfaces: a season-trends chart, an animated spray-chart
   "Diamond", a Tall-Can MVP picker, a per-player position-preference grid +
   per-night lineup builder, and a floating "Ask Beeves" chat that answers
   natural-language questions over the data via the Claude API.

Public GitHub: <https://github.com/gragedmonds/bumblebeers>.
Deployed via Vercel (root: `web/`). Auto-deploys on push to `main`.

---

## Top-level orientation

| File / dir | Purpose |
|---|---|
| `gamechanger_bumblebeers_raw.json` | Raw scrape: every team, every game, every event (~14 MB) |
| `gamechanger_season_stats.json` | Per-team season-stats blob from `/teams/{id}/season-stats` |
| `build_excel.py` | Raw JSON → `bumblebeers_gamechanger.xlsx` (Teams / Schedule / Players / AtBats / Pitches / BaseRunning / PlaysRaw / Errors) |
| `build_rankings.py` | `gamechanger_season_stats.json` + AtBats → `bumblebeers_rankings.xlsx` + `_pergame.json` (BMBL+ scores + per-game wOBA + career rollups) |
| `build_data_json.py` | `_pergame.json` + raw JSON + AtBats → `web/public/data/snapshot.json` (the payload the web app fetches). Replaces the legacy HTML emitter for the production deliverable. |
| `build_rankings_html.py` | **LEGACY** — the original single-file HTML viewer baker. Still importable (`build_data_json.py` reuses its `build_at_bats`, `build_mvp_nights`, `build_players_map`, `pk` helpers). The HTML output (`bumblebeers_rankings.html`) is no longer the production UI. |
| `viewer_template.html` | **LEGACY** — template for the old HTML viewer. Untouched in active dev. |
| `_pergame.json` | Build artifact bridging `build_rankings.py` → `build_data_json.py`. |
| `bumblebeers_*.xlsx` | Build artifacts. The web app does NOT read these — it reads `snapshot.json` only. |
| `BMBL_PLUS_PROPOSAL.md` | Design doc for the composite ranking formula. |
| `web/` | The Next.js 16 app. See [web/CLAUDE.md](web/CLAUDE.md). |
| `docs/DATA_SHAPES.md` | Persisted Redis schemas + snapshot.json shape reference. |
| `docs/CLAUDE_INTEGRATIONS.md` | The three Claude API touchpoints (Beeves chat, attendance OCR, lineup suggest), prompt-caching strategy, cost notes. |

## End-to-end build pipeline

```bash
# 1. (One-time per re-scrape) raw JSON → workbook
python build_excel.py

# 2. Compute BMBL+ scores + per-game wOBA + career rollups
python build_rankings.py

# 3. Emit web/public/data/snapshot.json (the production payload)
python build_data_json.py
```

Pipeline output the web app actually consumes: **only** `web/public/data/snapshot.json`. Commit and push it; Vercel auto-deploys.

The legacy `python build_rankings_html.py` step still works (writes `bumblebeers_rankings.html`) but the web app has replaced it as the primary deliverable.

## Re-scraping new games

GameChanger has no public API. To re-scrape after a new game:

1. Open `https://web.gc.com/teams/3nf5uPush7Ix/2025-summer-bumblebeers/schedule` in Chrome while signed in as `gregedmonds@gmail.com`.
2. Click into any game and visit its Plays tab — that primes the auth header.
3. Paste the scraper JS (see commit history; the scraper hits `api.team-manager.gc.com` with `gc-token` / `gc-device-id` / `gc-app-name` headers).
4. Drop the downloaded JSON in this folder, then run the build pipeline above.

API host: `api.team-manager.gc.com`. Endpoints used:

| Endpoint | Used for |
|---|---|
| `GET /me/teams` | List of all Bumblebee* team-season records |
| `GET /teams/{tid}` | Team detail + record |
| `GET /teams/{tid}/players` | Roster |
| `GET /teams/{tid}/schedule` | All events (games) |
| `GET /teams/{tid}/season-stats` | **Per-season per-player offense stats — authoritative for HR/RBI** |
| `GET /teams/{tid}/game-summaries` | Per-game score totals |
| `GET /events/{eid}/best-game-stream-id` | Resolves event → game-stream uuid |
| `GET /game-streams/{gsid}/events` | Play-by-play event log |

## Data quirks (gotchas)

### 1. GameChanger creates a fresh `player_id` per team-season.
Greg's 2018 and 2025 records have different IDs. Use lower-case `display_name` (first name) as the canonical `person_key`. Three manual aliases live in both `build_rankings.py` and `build_rankings_html.py`:

```python
NAME_ALIASES = {
    "alex tosun": "alex",
    "brandon porco": "porco",
    "z.terence": "terence",
    # "Chris USPL" deliberately NOT merged with "Chris"
}
```

### 2. Dates are stored as UTC.
A doubleheader played 7:30 PM + 9:15 PM EDT crosses midnight UTC and ends up on two different `date_only` values. The MVP tab buckets by **America/Toronto** local date to keep both games of a night together:

```python
utc = pd.to_datetime(df["date_local"], utc=True)
df["date_only"] = utc.dt.tz_convert("America/Toronto").dt.date.astype(str)
```

### 3. The play-by-play is *incomplete* for historical seasons.
Cross-checking against the authoritative `/season-stats` endpoint shows the play-by-play undercounts HRs significantly in older seasons:
- 2018 Jeff: 9 truth HR vs 1 in pbp
- 2022 Sean: 14 truth HR vs 1 in pbp
- 2024 Sean: 11 truth HR vs 3 in pbp

Scorers often shorthanded older games. **Use `gamechanger_season_stats.json` as the authoritative source for season totals.** MVP-night data uses pbp (since season-stats only has totals) — note the limitation.

### 4. Scoring runners are TOP-LEVEL `base_running` events, not nested.
Critical for RBI counting. Scorers tag runners crossing home as separate top-level events with `playType="advanced_on_last_play"` and `base=4`, **right after** the transaction. The data pipeline walks the raw play stream and attributes each scoring base_running to the most recent transaction in the same half-inning.

### 5. BMBL inning numbering is best-effort.
GameChanger's `end_half` events fire only on manual scorekeeper actions, not automatically at 3 outs. A 3-out fallback inside `build_excel.py`'s `GameState` class handles missing transitions but can drift on partially-scored games. The `bmbl_frame` column on the AtBats sheet is "Bumblebeers offensive frame N" rather than the real inning number on the GC website.

### 6. Greg only tracks Bumblebeers offense.
Opposing-team at-bats are NOT recorded in our scraper output (intentional — makes inning-tracking cleaner). The play-by-play includes opposing-team transactions but we ignore them in derived sheets.

### 7. Phase 3 runner state (Phase 3.5 enrichment).
Each at-bat in `snapshot.json` carries:
- `runners_before` / `runners_after` — base-state snapshots `{1, 2, 3}` of runner names
- `runner_moves` — explicit `{name, from, to}` transitions (`from: 0` = batter; `to: 4` = scored; `to: "out"` = put out)
- `half_inning_id` — groups consecutive at-bats in the same half-inning, used by the Diamond playback to know when to reset/seed

100% coverage on the snapshots; ~52% have explicit `runner_moves` (improves in newer seasons).

Guarantees enforced by the motion walker in `build_data_json.py`:
- **No duplicate runners on bases.** The same player can never appear on two bases at once in either `runners_before` or `runners_after`. `dedup_bases()` enforces this physical invariant after every state mutation, keeping the runner on the higher base (runners only advance forward).
- **`runs_scored` per AB is recomputed from `runner_moves`** (count of `to == 4`). The legacy run-counter only saw EXPLICIT scoring `base_running` events; the motion walker also folds in heuristic advancement (a runner on 2B is auto-scored on a double if the scorer didn't explicitly tag them).
- **`batter` is canonical from the motion walker**, not XLSX. The motion walker advances its lineup pointer for walks and strikeouts (which GameChanger never logs as transactions) as well as real ABs, so its batter identification stays in sync. The XLSX batter drifts wrong on ~33% of ABs after walks/Ks; the snapshot fixes this on emit. The motion walker also passes over slots whose player is currently on a base (real lineups skip over runners).

Residual noise (~2% of motion data) shows up as ghost runners (a runner in `before` that's gone in `after` with no `runner_moves` entry) and from/to-state mismatches. These trace to scorer undo/override/redundant `end_half` events that corrupt the play-by-play stream itself, beyond what the walker can reconstruct. `audit_motion.py` keeps a running count.

---

## The web app

See [web/CLAUDE.md](web/CLAUDE.md) for the full brief. TL;DR:

- **Routes:** `/lineup` (default home in nav order) → can-play/should-play pill grid + upcoming games + team-wide free-text notes. `/lineup/[YYYY-MM-DD]` → attendance editor (with poll-screenshot OCR) + Smart-fill lineup builder. `/` → Trends. `/diamond` → animated spray chart. `/mvp` → Tall-Can picker. **No `/ask` page** — Beeves is a floating chat widget on every page.
- **API:** `GET/PUT /api/lineup`, `GET/PUT /api/night/[date]`, `POST /api/attendance/parse`, `POST /api/lineup/suggest`, `GET /api/schedule`, `POST /api/ask` (SSE-streamed).
- **Storage:** Upstash Redis (managed via Vercel integration). Two keys: `bumblebeers:lineup` (shared can/should grid + roster overrides + team notes) and `bumblebeers:night:YYYY-MM-DD` (per-night attendance + game lineups).
- **Auto-save** everywhere — no Save buttons. 700ms debounce.
- **Claude integrations** — three touchpoints, all using Sonnet 4.6 with prompt caching. See `docs/CLAUDE_INTEGRATIONS.md`.

## Environment variables (Vercel)

| Var | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Beeves chat, attendance OCR, lineup suggest |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Upstash Redis (set automatically by the Vercel integration) |

When `ANTHROPIC_API_KEY` is missing, the AI routes return 503 with a friendly error. When the KV env is missing, the lineup/night routes return an empty payload with `x-bb-storage: unconfigured` so the UI degrades gracefully.

## Deploy + workflow

- Push to `main` → Vercel auto-deploys.
- Re-scrape workflow: run the 3 Python scripts → `git commit web/public/data/snapshot.json && git push`.
- No CI yet. Vercel runs `npm run build` itself (Turbopack, ~5s).

## Common operations

### Editing the can/should grid
`/lineup` → tap pills to cycle grey (none) → amber (can) → green (should) → grey. Saves automatically. The grid uses the active-roster filter (current season + ≥25 career PA, with manual `archived` / `added` overrides). Tiny chevron-down next to each name archives them; an "Add player" form below the grid pins new entries.

### Planning a night
`/lineup/[YYYY-MM-DD]` (or tap a card on `/lineup`). Mark attendees via IN/OUT toggles, OR upload a poll screenshot — Claude reads the names, matches to roster, populates the status map. Then "🐝 Generate both games" fires two Claude calls in sequence (game 1, then game 2 with game 1 passed as `prior_game` context so rotation notes resolve). 9 attendees → 9-player alignment (one CF). 10+ → 10-player alignment.

### Asking questions
Tap the floating 🐝 button on any page. Beeves answers from the data baked into a cached system prompt. Tables for leaderboards, bolded numbers for single-stat asks.

## Next-step ideas

In rough priority:

1. **Box-score endpoint discovery** — find the per-game per-player stats endpoint so HR/RBI per game becomes authoritative (not just season totals). Open any GameChanger game's Box Score tab while logged in; capture the network request.
2. **Tighten `runner_moves` coverage in older seasons** — the play-by-play tracker fills in 54% explicitly today. The remaining at-bats use a heuristic; making the heuristic better is straightforward.
3. **Calibrate slo-pitch wOBA weights from our data** — linear-regress half-inning runs against event counts on ~5,000 BMBL at-bats. Current weights are baseball-derived.
4. **Close-game leverage index** — tag each at-bat with a leverage value, then build a Clutch+ sub-score stricter than just RISP.
5. **xWOBA / expected-stats from fielder x,y coordinates** — train an xWOBA model where each point is "where did the ball land + what happened to it".
6. **Pitcher / defense splits** — currently only Bumblebeers offense is tracked. Adding opposing-team frames unlocks "when do we give up the most runs" / "who's hot against us".
7. **Head-to-head views** — filter Trends and Diamond by a specific opponent.
8. **Daily auto-update via GitHub Action** — wrap the scraper as a Python+Playwright script, run on cron, push the regenerated snapshot.
9. **Beeves tool-use mode** — when a question needs the per-at-bat raw data (currently excluded from the cached payload for cost), give Claude a `query_atbats(filter, group_by, metric)` tool.

## Style + workflow notes for future Claude sessions

- **The deliverable is the web app.** When the user asks for a feature, default to the Next.js side; the Python pipeline only changes when new data fields are needed.
- **Snapshots are produced by Python, consumed by TypeScript.** If a new field is needed, add it in `build_data_json.py`, add the type in `web/lib/data.ts`, then use it.
- **Auto-save is the convention.** Don't add Save buttons.
- **The roster is filtered, not enumerated.** Helpers in `web/lib/data.ts`: `getActiveRoster` (auto-rule), `applyRosterOverrides` (auto-rule + manual archived/added).
- **Three Claude calls, three caching strategies** — see `docs/CLAUDE_INTEGRATIONS.md`.
- **Greg prefers terse responses + concrete file paths in chat.** No "let me know if you want me to do X" — propose, then do.
- **Stay on Sonnet 4.6 unless the user explicitly says "use Opus".** Deep Mode is intentionally not exposed.
