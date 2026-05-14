# Data shapes

Every persistent shape in the project, in one place. Source of truth for the
types is `web/lib/*.ts`; this doc is a human-readable mirror with notes.

---

## 1. `snapshot.json`

**Location:** `web/public/data/snapshot.json`
**Produced by:** `python build_data_json.py` (root of repo).
**Consumed by:** every page in the Next.js app via `useSnapshot()` (client)
or `loadSnapshot()` (server). Also fed into the Beeves system prompt via
`lib/ask-prompt.ts`.

Static — committed to git, regenerated on each re-scrape.

### Top-level shape (`Snapshot` in `lib/data.ts`)

```ts
{
  generated_at: string;                          // ISO-8601 UTC, used as cache key
  players: Record<person_key, Player>;           // 32 entries today (all-time)
  career_weighted: Record<person_key, CareerWeighted>;
  weights: Record<string, number>;               // BMBL+ component weights (e.g. {"wOBA": 0.4, "ISO": 0.10, ...})
  at_bats: AtBat[];                              // ~5,240 entries; the spray-chart payload
  mvp_nights: MvpNight[];                        // 114 entries today
}
```

### `Player`

```ts
{
  display_name: string;     // "Greg", "Sean", "Mikey", ...
  seasons: PlayerSeason[];  // one per season the player appeared in
  games: PlayerGame[];      // one per game played
}
```

### `PlayerSeason`

```ts
{
  season_year: number;       // 2018..2025
  PA: number;                // plate appearances (from BMBL+ pipeline)
  wOBA: number | null;       // weighted on-base average
  BMBL_plus: number | null;  // composite ranking (100 = team-season avg, 25 = 1 stddev)
  qualified: boolean;        // >= 25 PA for the season
  stats?: PlayerSeasonStats; // AUTHORITATIVE offense totals — see below
}
```

### `PlayerSeasonStats` — authoritative season totals

Lifted from GameChanger's `/teams/{tid}/season-stats` endpoint (NOT the
play-by-play). Present on most seasons (~123/210 player-season entries —
the rest didn't have a season-stats row, typically because the player had
0 PA).

```ts
{
  PA?: number;
  AB?: number;
  H?: number;
  "1B"?: number;
  "2B"?: number;
  "3B"?: number;
  HR?: number;     // TRUE HR count. The play-by-play undercounts HRs in older seasons.
  TB?: number;
  BB?: number;     // Walks. NOT recorded per-AB anywhere else.
  SO?: number;     // Strikeouts. NOT recorded per-AB anywhere else.
  HBP?: number;    // Hit-by-pitch. NOT recorded per-AB anywhere else.
  SF?: number;
  FC?: number;
  ROE?: number;
  R?: number;
  RBI?: number;
  SB?: number;
  CS?: number;
  AVG?: number;
  OB?: number;
}
```

**Why this matters**: the play-by-play stream (and therefore the `at_bats`
array below) does NOT record strikeouts / walks / HBPs at all. The
GameChanger scorers only log balls put in play — pitch counts and balls
called for strikes are not in the source data. This `stats` block is the
ONLY place those numbers live, and it's per-season-totals-only.

For HR leaderboards: trust `seasons[].stats.HR`, not counts derived from
`at_bats`. Older seasons especially undercount HRs in the pbp.

### `PlayerGame`

```ts
{
  date: string;          // YYYY-MM-DD (Toronto-local)
  season_year: number;
  opponent: string | null;
  PA: number;
  AB: number;
  H: number;
  HR: number;
  wOBA_game: number | null;  // shrunk per-game wOBA (k=50 Bayesian)
}
```

### `CareerWeighted`

```ts
{
  person_key: string;
  display_name: string;
  seasons_qualified: number;
  career_PA: number;
  career_BMBLplus_weighted: number;
  seasons_played: string;       // comma-joined years, e.g. "2018, 2019, 2021"
  peak_season_year: number;
  peak_BMBLplus: number;
}
```

### `AtBat` — the spray-chart / diamond payload

```ts
{
  person_key: string;             // canonical key (lowercased first name w/ aliases applied)
  batter: string | null;          // display name
  season_year: number;
  date: string | null;            // YYYY-MM-DD (Toronto-local)
  opponent: string | null;
  result: AtBatResult | string | null;  // see below
  play_type: string | null;       // "line_drive", "fly_ball", "ground_ball", "pop_fly", "bunt", ...
  defender_position: string | null;
  field_zone: "infield" | "outfield" | "other";
  field_side: "left" | "middle" | "right" | "other";
  runs_scored: number;            // batter + any scoring runners attributed to this AB
  run_scoring: boolean;           // runs_scored > 0
  x: number | null;               // SVG x of where the ball landed / was fielded
  y: number | null;               // SVG y
  transaction_seq: number;        // sequence_number from the raw play stream
  event_id: string | null;        // GameChanger event UUID
  runners_before: BaseSnapshot;   // {1, 2, 3} → name|null — runners on each base BEFORE the pitch
  runners_after:  BaseSnapshot;   // ditto, AFTER the play resolves
  runner_moves:   RunnerMove[];   // explicit transitions (see below)
  half_inning_id: string | null;  // {event_id}:{half_inning_index} — groups ABs in same inning
}
```

`AtBatResult` union: `"single" | "double" | "triple" | "home_run" | "sacrifice_fly" | "fielders_choice" | "error" | "batter_out" | "batter_out_advance_runners" | "infield_fly" | "other_out" | "dropped_third_strike_batter_out" | "strike_out"`.

### `BaseSnapshot`

```ts
{
  "1": string | null;  // runner name on 1B (or null)
  "2": string | null;
  "3": string | null;
}
```

### `RunnerMove`

```ts
{
  name: string;
  from: 0 | 1 | 2 | 3;          // 0 = batter (steps out of the box at home plate)
  to:   1 | 2 | 3 | 4 | "out";  // 4 = scored; "out" = put out (heads to dugout)
}
```

**Coverage notes** (verified by audit):
- `runners_before` / `runners_after` / `half_inning_id`: **100%** of at-bats.
- `runner_moves`: **54%** of at-bats explicitly. Newer seasons (2024/2025) have ~72% with someone on base; older seasons (2018) ~54%. Older play-by-play tagged fewer base-running events.
- The Diamond visual uses `runners_before` to **seed** the field at half-inning boundaries, then animates `runner_moves` for transitions. Stranded runners are cleared when `half_inning_id` changes on the next AB.

### `MvpNight`

```ts
{
  date: string;                // YYYY-MM-DD
  season_year: number;
  opponents: string[];         // typically 1-2 (doubleheader)
  mvp: MvpLine;
  runner_up: MvpLine | null;
  top: MvpLine[];              // top 5 of the night
  justification: string;       // 1-3 sentence auto-generated text
}
```

### `MvpLine`

```ts
{
  person_key: string;
  display_name: string;
  score: number;       // TB×1.5 + runs×1.2 + HR×1.5 + XBH×0.8 + SF×0.5 − outs×0.4
  PA: number;
  AB: number;
  H: number;
  "1B": number; "2B": number; "3B": number; HR: number;
  TB: number; XBH: number; SF: number; ROE: number;
  outs: number;
  runs_scored: number;
}
```

---

## 2. Upstash Redis — shared `Lineup` blob

**Key:** `bumblebeers:lineup`
**Read/written by:** `GET/PUT /api/lineup`. Also read by `/api/lineup/suggest`
(via the body) and `/api/attendance/parse` (to compose the active roster with
`added` overrides).

```ts
{
  matrix: Record<person_key, Partial<Record<Pos, "can" | "should">>>;
  // Sparse — only marked cells stored. "none" is collapsed to absent.
  // Example: { "greg": { "P": "should", "SS": "can" }, "sean": { ... } }

  team_notes: string;
  // Single shared free-text block. Read by Claude during Smart fill.
  // ≤4000 chars. Empty by default.
  // Example: "If Greg pitches, he pitches the whole game.\nRotate catchers across games."

  archived: string[];
  // person_keys explicitly hidden from the active roster (overrides the auto-rule).
  // Capped at 100 entries.

  added: { key: string; display_name: string }[];
  // person_keys explicitly shown (overrides the auto-rule). May include keys not
  // in snapshot.players (brand-new players). Capped at 100 entries.

  updated_at: string;  // ISO-8601 UTC
}
```

`Pos` = `"P" | "C" | "1B" | "2B" | "SS" | "3B" | "LF" | "LCF" | "RCF" | "RF"`.

### Active-roster resolution

The displayed roster on `/lineup` is computed as:

```ts
final = (autoActive ∪ lineup.added) − lineup.archived
```

Where `autoActive` is everyone in `snapshot.players` who:
- played in the latest season the snapshot knows about (`latestSeason()`)
- AND has ≥25 career PA across all seasons

Implementation: `applyRosterOverrides(snapshot, {archived, added})` in
`lib/data.ts`.

---

## 3. Upstash Redis — per-night blob

**Key:** `bumblebeers:night:YYYY-MM-DD` (e.g. `bumblebeers:night:2026-05-13`).
**Read/written by:** `GET/PUT /api/night/[date]`.

```ts
{
  date: string;          // YYYY-MM-DD
  opponent?: string;     // populated from schedule lookup or manual edit
  notes?: string;        // (currently unused — UI doesn't expose per-night notes)

  attendance: {
    status: Record<person_key, "in" | "out">;
    // ONLY the people you've marked. Missing keys = "unknown" (not asked yet).

    unmatched_in:  string[];  // names from screenshot OCR that didn't match the roster
    unmatched_out: string[];  // same, for Out / Maybe bucket
  };

  games: GameLineup[];
  // Length 0 (no lineups built yet) OR 2 (a doubleheader).
  // Each game is { innings: InningLineup[8] }
  // Each InningLineup is { [Pos]: person_key | undefined }

  updated_at: string;  // ISO-8601 UTC
}
```

```ts
type GameLineup    = { innings: InningLineup[] };          // length always 8 after sanitise
type InningLineup  = Partial<Record<Pos, string>>;          // [Pos] = person_key
```

### 9-player vs 10-player alignment

If you started a night with 10+ attendees, the games' inning maps will have
all 10 positions filled (P, C, 1B, 2B, SS, 3B, LF, LCF, RCF, RF). If 9
attendees, RCF is omitted — LCF acts as the single CF.

Storage doesn't distinguish modes; the UI infers mode from attendee count at
render time. RCF cells in a 9-player night just don't get filled (and won't
be sent back by `/api/lineup/suggest` either).

---

## 4. HTOSports scrape result

**Endpoint:** `GET /api/schedule` (`web/app/api/schedule/route.ts`).
**Source:** `https://www.htosports.com/teams/default.asp?u=YRMSPL&s=softball&p=schedule&div=1027186` parsed with cheerio.
**Cached:** 1 hour via Next.js `revalidate`.

```ts
{
  source: string;          // the HTOSports URL
  fetched_at: string;      // ISO-8601 UTC
  nights: NightSchedule[];
}
```

```ts
NightSchedule = {
  date: string;                                 // YYYY-MM-DD
  day: string;                                  // "Wednesday", "Thursday", ...
  opponent: string;                             // "IMPERIALS", "DRAGONS", ...
  location: string;                             // "HEADWATER", "MILLIKEN # 4", ...
  games: {
    date: string;
    time: string;                               // "7:30 PM"
    opponent: string;
    location: string;
    homeAway: "home" | "away";
    score: string | null;
    gameId: string | null;                      // HTO gameID query param
  }[];
};
```

Typical Bumblebeers night = 2 games (one home, one away, ~1:45 apart).

---

## 5. Diamond animation runtime state (not persisted)

Lives only in the Diamond component memory. Documented here because the
data flow into the visualization is non-obvious.

```ts
// Persistent base-runner squares — survive across at-bats in the same half-inning.
runnersRef: Map<runnerKey, RunnerSquare>

RunnerSquare = {
  name: string;
  base: 0 | 1 | 2 | 3;     // last known stationary base (4/"out" = removed)
  rect: SVGRectElement;
  label: SVGTextElement;
}

// Tracks whether the current AB is in a new half-inning vs the previous one.
lastHalfInningRef: string | null
```

Half-inning transition algorithm (per AB):
1. Compare `ab.half_inning_id` with `lastHalfInningRef.current`.
2. If different (inning change OR very first AB):
   - Fire-and-forget `clearAllRunners(map, 220ms)` (existing runners fade off).
   - Then `seedRunnersFromSnapshot(map, ab.runners_before)` populates new squares.
   - Update `lastHalfInningRef.current = ab.half_inning_id`.
3. Otherwise (same half-inning, consecutive AB): trust the map's existing state.
4. After the ball animation completes, apply `ab.runner_moves` sequentially:
   - `from: 0` → create a new square at home, tween through every intermediate base to `to`.
   - `from: 1|2|3` → look up existing square; tween through intermediate bases.
   - `to: 4` → tween to home then fade off (scored).
   - `to: "out"` → tween to `DUGOUT_POINT` (`{x: -60, y: 400}`) then fade.
5. If this AB was the **last** of its half-inning (next AB has a different
   `half_inning_id` OR no next AB), fire `clearAllRunners` ~300ms after the
   move animation lands — strands clear visually.

Chronological traversal is enforced: a runner going from 1B to home walks
1B → 2B → 3B → home, never diagonally across the infield.

---

## 6. Identifiers + conventions

### `person_key`
Lowercase first name with manual aliases applied. Stable across team-seasons
(GameChanger creates new player IDs per team-season; we collapse them by name).

Three current aliases:
- `"alex tosun"` → `"alex"`
- `"brandon porco"` → `"porco"`
- `"z.terence"` → `"terence"`

Plus deliberate non-merges: `"chris uspl"` is NOT merged with `"chris"`
(different people).

Slugifier for new manually-added players: `slugifyKey()` in `lib/data.ts` —
lowercases, replaces non-alphanumeric with `-`, caps at 32 chars.

### `half_inning_id`
Format: `{event_id}:{half_inning_index}` (e.g. `08aa5bb2-5d17-4c95-a264-9c1881b796b3:3`).
Groups consecutive at-bats in the same half-inning. The Diamond visual uses
this to know when to clear runners; the data pipeline derives it from the
raw play stream by counting `end_half` events.

### `transaction_seq`
The `sequence_number` field from the raw play stream's transaction event for
this at-bat. Used (together with `event_id`) to key the `runners_before`
lookup in `build_data_json.py`. Strictly increasing within a game.

### Dates
- **`date`** on at-bats and mvp_nights is always **YYYY-MM-DD in `America/Toronto`** — converted from the play stream's UTC timestamps so a doubleheader that crosses midnight UTC still buckets to one local date.
- **`generated_at`** / **`updated_at`** / **`fetched_at`** are ISO-8601 UTC.

---

## 7. JSON / TypeScript drift checklist

When adding a new field to a persisted shape:

| Shape | Source of truth | Sanitiser | TypeScript types |
|---|---|---|---|
| `Snapshot.*` | `build_data_json.py` (Python) | n/a — read-only | `web/lib/data.ts` |
| `Lineup` | `web/app/api/lineup/route.ts` | `sanitizeLineup()` in `lib/lineup.ts` | `lib/lineup.ts` |
| `PersistedNight` | `web/app/api/night/[date]/route.ts` | `sanitizeNight()` in `lib/night.ts` | `lib/night.ts` |
| `NightSchedule` | `web/app/api/schedule/route.ts` | n/a — derived from HTML | `lib/schedule.ts` |

Always add the field to the sanitiser too — unknown fields are silently
dropped by the PUT route, which means a UI write can disappear if the
sanitiser doesn't allowlist it.
