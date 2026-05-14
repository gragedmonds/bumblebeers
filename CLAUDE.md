# Bumblebeers — GameChanger stats project

Adult slo-pitch softball team's statistical analytics pipeline. Scrapes GameChanger
(no public API), produces an Excel workbook and a single-file interactive HTML
viewer with three tabs: **Trends**, **Diamond** (animated spray chart), and
**🍺 MVP** (per-night Tall-Can-recipient picker).

## Quick orientation

| File | Purpose |
|---|---|
| `gamechanger_bumblebeers_raw.json` | Raw scrape: every team, every game, every event (~14 MB) |
| `gamechanger_season_stats.json` | Per-team season-stats blob from `/teams/{id}/season-stats` |
| `bumblebeers_gamechanger.xlsx` | Multi-sheet workbook: Teams / Schedule / Players / AtBats / Pitches / BaseRunning / PlaysRaw / Errors |
| `bumblebeers_rankings.xlsx` | BMBL+ score workbook: Summary / Components / YearByYear / Career_Weighted / Career_Totals / Reconciliation / PerGame / Weights / RawStats |
| `bumblebeers_rankings.html` | Single-file interactive viewer with 3 tabs. Double-click to open. |
| `BMBL_PLUS_PROPOSAL.md` | Design doc for the composite ranking |
| `build_excel.py` | Raw JSON → `bumblebeers_gamechanger.xlsx` |
| `build_rankings.py` | `gamechanger_season_stats.json` + AtBats → `bumblebeers_rankings.xlsx` + `_pergame.json` |
| `build_rankings_html.py` | `_pergame.json` + raw JSON + AtBats → `bumblebeers_rankings.html` |
| `viewer_template.html` | The HTML/CSS/JS template. **Has a known truncation hazard — see below.** |
| `_smoke_stub.js` / `_smoke_stub_bottom.js` | DOM stubs for the JS validation step |
| `_pergame.json` | Intermediate — bridge between `build_rankings.py` and the HTML builder |

## Build pipeline

```bash
# 1. Raw JSON → workbook (only needed when re-scraping or fixing aggregation)
python build_excel.py

# 2. Compute BMBL+ scores + per-game wOBA + career rollups
python build_rankings.py

# 3. Bake the interactive viewer (includes a hard JS validation step)
python build_rankings_html.py
```

`build_rankings_html.py` runs both `node --check` (syntax) and a smoke-execution
with stubbed DOM (`document`, `window`, `Option`, `Chart`, etc.) that explicitly
calls `initDiamond()`, `initMvp()`, and `renderMvpList()`. **It refuses to write
the HTML if any check fails**, so the page can't silently hang in the browser.

## Re-scraping new games

GameChanger has no public API. To re-scrape after a new game:

1. Open `https://web.gc.com/teams/3nf5uPush7Ix/2025-summer-bumblebeers/schedule`
   in Chrome while signed in as `gregedmonds@gmail.com`.
2. Click into any game and visit its Plays tab — that primes the auth header.
3. Paste the scraper JS (see `BMBL_PLUS_PROPOSAL.md` history and the original
   `gamechanger_bumblebeers_raw.json` generation flow in the chat transcript).
4. Drop the downloaded JSON in this folder, then run the build pipeline above.

The scraper hits these endpoints with `gc-token` / `gc-device-id` / `gc-app-name`
headers (no Authorization, no cookies). API host: `api.team-manager.gc.com`.

| Endpoint | Used for |
|---|---|
| `GET /me/teams` | List of all Bumblebee* team-season records |
| `GET /teams/{tid}` | Team detail + record |
| `GET /teams/{tid}/players` | Roster |
| `GET /teams/{tid}/schedule` | All events (games) |
| `GET /teams/{tid}/season-stats` | **Per-season per-player offense stats — authoritative for HR/RBI** |
| `GET /teams/{tid}/game-summaries` | Per-game score totals |
| `GET /teams/{tid}/opponent/{oid}` | Opponent metadata |
| `GET /events/{eid}/best-game-stream-id` | Resolves an event → game-stream uuid |
| `GET /game-streams/{gsid}/events` | The play-by-play event log |

## Data quirks (gotchas)

### 1. GameChanger creates a fresh `player_id` per team-season.
Greg's 2018 and 2025 records have different IDs. Use lower-case `display_name`
(first name) as the canonical `person_key`. Three manual aliases live in both
`build_rankings.py` and `build_rankings_html.py`:

```python
NAME_ALIASES = {
    "alex tosun": "alex",
    "brandon porco": "porco",
    "z.terence": "terence",
    # "Chris USPL" deliberately NOT merged with "Chris"
}
```

### 2. Dates are stored as UTC.
A doubleheader played 7:30 PM + 9 PM EDT crosses midnight UTC and ends up on
two different `date_only` values. The MVP tab buckets by **America/Toronto**
local date to keep both games of a night together:

```python
utc = pd.to_datetime(df["date_local"], utc=True)
df["date_only"] = utc.dt.tz_convert("America/Toronto").dt.date.astype(str)
```

### 3. The play-by-play is *incomplete* for historical seasons.
Cross-checking against the authoritative `/season-stats` endpoint shows the
play-by-play undercount HRs significantly in older seasons:
- 2018 Jeff: 9 truth HR vs 1 in pbp
- 2022 Sean: 14 truth HR vs 1 in pbp
- 2024 Sean: 11 truth HR vs 3 in pbp

Scorers often shorthanded older games. **Use `gamechanger_season_stats.json`
as the authoritative source for season totals.** The MVP tab uses pbp for
per-night detail (since season-stats only has totals) — note the limitation.

### 4. Scoring runners are TOP-LEVEL `base_running` events, not nested.
Critical for RBI counting. Scorers tag runners crossing home as separate
top-level events with `playType="advanced_on_last_play"` and `base=4`,
**right after** the transaction. There are 751 of these top-level events
versus only 153 inside transactions — so `build_rankings_html.py` walks the
raw play stream and attributes each scoring base_running to the most recent
transaction in the same half-inning.

```python
for p in plays:                          # sorted by sequence_number
    if code == "transaction": last_tx_seq = p["sequence_number"]
    elif code == "base_running" and attrs.get("base") == 4:
        # attribute to last_tx_seq
    elif code == "end_half": last_tx_seq = None
```

### 5. BMBL inning numbering is best-effort.
GameChanger's `end_half` events fire only on manual scorekeeper actions, not
automatically at 3 outs. A 3-out fallback inside `build_excel.py`'s `GameState`
class handles missing transitions but can drift on partially-scored games.
The `bmbl_frame` column on the AtBats sheet is "Bumblebeers offensive frame
N" rather than the real inning number on the GC website.

### 6. Greg only tracks Bumblebeers offense.
Opposing-team at-bats are NOT recorded in our scraper output (intentional —
makes inning-tracking cleaner). The play-by-play includes opposing-team
transactions but we ignore them in derived sheets.

## Viewer template quirk — read this before editing the HTML

`viewer_template.html` gets its tail silently truncated by external tooling
on large edits. **Do not put critical code at the end of the template.**

`build_rankings_html.py` defends against this with two patterns:

1. **Strip-and-replace**: it finds `function animateAtBat(ab) {` in the
   template, truncates everything from that line onward, then injects a
   canonical `ANIMATE_AT_BAT_TAIL` Python constant containing the rest of
   the JS (Diamond animation, MVP tab logic, init wiring, closing tags).
2. **JS validation**: `node --check` + a stubbed-DOM smoke-execution. The
   build refuses to write `bumblebeers_rankings.html` if anything fails.

If you must add JS that goes at the end of the file, **add it to the
`ANIMATE_AT_BAT_TAIL` Python constant** in `build_rankings_html.py`, not the
template. The template should only carry HTML structure + CSS + the JS that
sits before `function animateAtBat`.

## Architecture decisions

### Why vanilla HTML + Chart.js, not React/Next/Vite?
The deliverable is a file that Greg double-clicks on Windows. No build step,
no node server, no npm install. Data is embedded as a JS literal so the page
works offline. **If we outgrow this** (multi-user, complex interactivity,
mobile-first), the natural next step is **Vite + a tiny React app** — the
data can become a JSON sibling file and most of the existing JS port over
cleanly.

### BMBL+ score formula
```
BMBL+ = 100 + 25 × Σ (weight_i × z_score_i)
```

| Tier | Component | Weight |
|---|---|---:|
| Production | wOBA (linear weights, shrunk to season mean k=50) | 40% |
| Power | ISO = SLG − AVG | 10% |
| Clutch | RISP_diff (BA/RISP − AVG) | 10% |
| Clutch | 2-out RBI rate | 8% |
| Clutch | Productive-out rate (SF + SHB)/PA | 7% |
| Discipline | K avoidance (1 − SO/PA) | 5% |
| Discipline | BB rate | 5% |
| Discipline | QAB% | 5% |
| Contact | Hard contact % | 6% |
| Contact | Line drive % | 4% |

100 = team-season average, 1 stddev = 25 points. Min 25 PA to qualify.
Bayesian shrinkage on wOBA only.

### MVP-night score formula
```
score = TB×1.5 + runs_scored×1.2 + HR×1.5 + XBH×0.8 + SF×0.5 − outs×0.4
```
Min 2 PAs for MVP eligibility. Tied scores break on TB then H.

The "justification" auto-text branches on margin %:
- `>=40%`: "X (line) — clear-cut night."
- `10-40%`: "X (line) edged Y (line) on {differentiator}."
- `<10%`: "Tight race — X (line) over Y (line) on {differentiator}."

Differentiator priority: HR > XBH > TB > runs_scored > H > fewer-outs.

## Next-step ideas (in priority order)

1. **Box score endpoint** — find the per-game per-player stats endpoint so we
   get authoritative HR/RBI per game (not season totals). The web UI's Box
   Score tab probably calls something like `/events/{eid}/box-score` or
   pulls from a Sabertooth processing endpoint. Greg is logged in now — open
   any game's Box Score tab and capture the network requests.

2. **Calibrate slo-pitch wOBA weights from our data**. Linear-regress
   half-inning runs against event counts on ~5,000 BMBL at-bats. The current
   weights are baseball-derived (BB=0.69, 1B=0.88, etc.).

3. **Close-game leverage index**. Use `override` score events to tag each
   at-bat with a leverage value, then build a Clutch+ sub-score that's
   stricter than just RISP.

4. **xWOBA / expected-stats** from fielder x,y coordinates. We have defender
   position for every at-bat in `AtBats` — train an xWOBA model where each
   point is "where did the ball land + what happened to it".

5. **Pitcher / defense splits**. Currently we only track Bumblebeers offense.
   Adding the opposing-team frames would let us see when our team gives up
   the most runs, who's hot against us, etc.

6. **Head-to-head views**. Filter to a specific opponent (e.g., career stats
   vs Mets) for both Trends and Diamond tabs.

7. **Age curve / multi-year projection**. With 7 seasons per regular, we can
   fit a simple aging curve and project next season's BMBL+.

8. **Daily auto-update**. Currently re-scraping requires a manual JS paste.
   Wrap the scraper as a Python+Playwright script that signs in, captures
   token, and pulls. Could schedule via Windows Task Scheduler.

## Open work when this session ends

- ✅ RBI attribution from top-level base_running events — **just fixed**
- ⏳ HR undercounting in older seasons — needs box-score endpoint OR
     heuristic apportionment from season totals
- ⏳ The 4 "questionable name pairs" got resolved (Alex+Tosun merged,
     Brandon-Porco+Porco merged, z.Terence+Terence merged, Chris USPL kept
     separate). Same aliases live in both `build_rankings.py` and
     `build_rankings_html.py` — keep them in sync if you add new ones.

## Test the build

```bash
python build_rankings.py        # rebuild scores
python build_rankings_html.py   # rebuild HTML; fails loudly if JS is broken
# Expected end-of-output: "JS check passed. wrote ... (~2.4 MB, ~5240 at-bats, 114 MVP nights)"
```

If the JS validator complains, **don't ship**. Read the error, fix the
issue, and rebuild. The validator is your first line of defense against
"page loads but nothing's clickable" hangs.
