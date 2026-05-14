# Bumblebeers — web app (`web/`)

Next.js 16 App Router, TypeScript, Tailwind v4, deployed to Vercel. Reads
`public/data/snapshot.json` (committed; rebuilt by the parent repo's Python
pipeline) and persists per-night state to Upstash Redis.

**Read [AGENTS.md](AGENTS.md) first** — it has the Next.js 16 breaking-change
warning. Then this file.

For the full project context, see [../CLAUDE.md](../CLAUDE.md). For schemas,
see [../docs/DATA_SHAPES.md](../docs/DATA_SHAPES.md). For the Claude API
touchpoints, see [../docs/CLAUDE_INTEGRATIONS.md](../docs/CLAUDE_INTEGRATIONS.md).

---

## Route map

### Pages

| Path | File | What it does |
|---|---|---|
| `/` | `app/page.tsx` | **Trends** — Chart.js line chart of BMBL+ / wOBA / PA / hits across selectable players + years, plus career rollup table. Wraps `components/Trends.tsx`. |
| `/lineup` | `app/lineup/page.tsx` | **Lineup root** — upcoming-games card (links into night pages) + team-wide free-text notes + active-roster can/should pill grid. Wraps `components/UpcomingGames.tsx` + `components/LineupGrid.tsx`. |
| `/lineup/[date]` | `app/lineup/[date]/page.tsx` | **Per-night planner** — date is `YYYY-MM-DD`. Hosts `components/NightPlanner.tsx` which composes `AttendanceEditor` (with poll-screenshot upload) + `LineupBuilder` (Smart-fill button generates both games via Claude). |
| `/diamond` | `app/diamond/page.tsx` | **Animated spray chart** — playback with persistent base-runner squares that traverse bases chronologically, dugout exit on outs, half-inning reset. Wraps `components/Diamond.tsx`. |
| `/mvp` | `app/mvp/page.tsx` | **Tall-Can MVP picker** — per-night MVPs with justifications + tally. Wraps `components/MvpList.tsx`. |

There is **no `/ask` page**. Beeves (the chat) lives as a floating button in
the layout and opens an inline panel.

### API routes

| Method + Path | File | Body / Returns |
|---|---|---|
| `GET /api/lineup` | `app/api/lineup/route.ts` | Returns shared `Lineup` blob from `bumblebeers:lineup`. Sets `x-bb-storage: unconfigured` header when Upstash env is missing. |
| `PUT /api/lineup` | same | Body = full `Lineup`. Sanitised + written to Redis. |
| `GET /api/night/[date]` | `app/api/night/[date]/route.ts` | Returns `{night: PersistedNight}` for `bumblebeers:night:YYYY-MM-DD`. |
| `PUT /api/night/[date]` | same | Body = full `PersistedNight`. Validates date, sanitises, writes. |
| `POST /api/attendance/parse` | `app/api/attendance/parse/route.ts` | Body = `{image_base64, image_media_type, self_key?}`. Calls Claude vision with the roster baked into the prompt; returns matched `in`/`out` lists + unmatched names. |
| `POST /api/lineup/suggest` | `app/api/lineup/suggest/route.ts` | Body = `{attendees, prefs, team_notes, game_num, opponent?, mode?, existing?, prior_game?}`. Returns `{innings[8], explanation, model, usage, mode}`. Claude fills the lineup respecting team notes + can/should marks + prior-game context. |
| `GET /api/schedule` | `app/api/schedule/route.ts` | Scrapes HTOSports with cheerio, groups into doubleheader-aware nights. Cached 1 hour. |
| `POST /api/ask` | `app/api/ask/route.ts` | Body = `{question, history?}`. Streams Server-Sent Events: `text` chunks, then `done` with usage stats, or `error`. |

`runtime: "nodejs"` on every API route. `dynamic: "force-dynamic"` on the
ones that hit Redis or Claude (so Vercel doesn't try to prerender them).

---

## `lib/` — shared modules

| File | Exports | Notes |
|---|---|---|
| `data.ts` | `Snapshot`, `AtBat`, `Player`, `MvpNight`, `RunnerMove`, etc. + `getActiveRoster`, `getFullRoster`, `applyRosterOverrides`, `slugifyKey`, `latestSeason` | All snapshot-related types + roster filtering helpers. Pure functions — no Redis, no fs. |
| `data-server.ts` | `loadSnapshot()`, `loadRoster()` | Server-only. Reads `public/data/snapshot.json` from disk. Module-cached. |
| `lineup.ts` | `Pos`, `LineupMode`, `POSITIONS`, `POSITIONS_BY_MODE`, `positionLabel`, `modeForAttendeeCount`, `Lineup`, `EMPTY_LINEUP`, `LINEUP_KEY`, `getRedis()`, `sanitizeLineup()` | The shared can/should grid types + Redis adapter. Used by `/api/lineup` and `/api/lineup/suggest`. |
| `night.ts` | `Availability`, `InningLineup`, `GameLineup`, `PersistedNight`, `Attendance`, `nightKey()`, `emptyNight()`, `getRedis()`, `isValidDate()`, `sanitizeNight()` | Per-night persistence types. Duplicates `getRedis()` from `lineup.ts` — minor DRY violation, harmless. |
| `schedule.ts` | `ScheduledGame`, `NightSchedule`, `HTO_URL`, `groupIntoNights()`, `normalizeTime()`, `parseWeekday()` | HTOSports schedule types + helpers. |
| `claude.ts` | `getAnthropic()`, `MODELS`, `extractAttendeesFromImage()`, `SupportedImageType` | Server-only Anthropic SDK wrapper. Lazy-inits the client. `MODELS.default = "claude-sonnet-4-6"`, `MODELS.smart = "claude-opus-4-7"` (not currently used). |
| `ask-prompt.ts` | `buildAskDataBlock()`, `instructions()` | The Beeves system prompt + the compact stats payload (cached by `snapshot.generated_at`). |
| `useSnapshot.ts` | `useSnapshot()` | Client hook: fetch-once `/data/snapshot.json` + module-level cache, returns `{snapshot, error}`. |
| `match.ts` | `matchNames()` | **DEAD CODE** — original fuzzy name matcher. Replaced by Claude-side roster matching in `extractAttendeesFromImage`. Kept for now in case we ever need a non-LLM fallback. |

---

## `components/`

All client components (`"use client"`).

| Component | Used on | Purpose |
|---|---|---|
| `Nav.tsx` (`app/components/`) | layout | Sticky top nav. Order: Lineup / Trends / Diamond / 🍺 MVP. No Ask tab. |
| `AskBeeves.tsx` (`app/components/`) | layout | Floating 🐝 button + inline chat panel (bottom sheet on phone, drawer in corner on tablet+). Module-scope thread cache. Custom `react-markdown` component map for tables, bold, code. SSE stream from `/api/ask`. |
| `Trends.tsx` | `/` | Player checkbox list (sorted by career BMBL+), metric selector (BMBL+ / wOBA / PA / hits), granularity (season / 5-game rolling / per-game), year range. Renders a Chart.js line chart + career rollup table. |
| `LineupGrid.tsx` | `/lineup` | The pill grid. Auto-saves on edit (700ms debounce). Includes team-notes textarea, archive button (tiny chevron-down), add-player form, "Show archived (N)" toggle. |
| `UpcomingGames.tsx` | `/lineup` | Calls `/api/schedule`, shows next 3 nights with home/away tags. Each card links to `/lineup/[date]`. |
| `NightPlanner.tsx` | `/lineup/[date]` | Container component. Fetches `/api/night/[date]`, `/api/lineup`, `/api/schedule` in parallel. Auto-saves night state on edit. Hosts AttendanceEditor + LineupBuilder. |
| `AttendanceEditor.tsx` | `/lineup/[date]` | IN/OUT toggle per roster player + "Upload poll screenshot" button. Shows In/Out counts and unmatched-from-screenshot names. |
| `LineupBuilder.tsx` | `/lineup/[date]` | Tabbed Game 1 / Game 2, 8-inning × N-position grid. Auto-picks 9p vs 10p mode from attendee count. One **🐝 Generate both games** button fires `/api/lineup/suggest` twice (game 1, then game 2 with game 1 as `prior_game`). |
| `Diamond.tsx` | `/diamond` | SVG diamond + animated spray playback. Persistent base-runner squares that traverse bases chronologically (no diagonals), exit to dugout on outs, clear after the last AB of a half-inning. |
| `MvpList.tsx` | `/mvp` | Per-night MVP cards with justification text + filterable tally. |
| `RosterIntake.tsx` | (unused) | Older standalone screenshot-upload widget. Currently not mounted anywhere. Candidate for deletion. |

---

## Persisted state (Upstash Redis)

Two keys total:

```
bumblebeers:lineup               → Lineup (shared can/should grid)
bumblebeers:night:YYYY-MM-DD     → PersistedNight (per-night attendance + games)
```

For full field-by-field schemas see [../docs/DATA_SHAPES.md](../docs/DATA_SHAPES.md).

---

## Conventions

### Auto-save
Every editable page debounces edits 700ms then PUTs the full blob to its
route. **No Save buttons.** The status text in each toolbar reads:
- "Saving…" while a PUT is in flight
- "Unsaved (auto-saves in a moment)" while the debounce timer is running
- "Saved · <timestamp>" otherwise

Implementation pattern in `LineupGrid.tsx` + `NightPlanner.tsx`:

```tsx
const latestRef = useRef(state);
useEffect(() => { latestRef.current = state; }, [state]);
useEffect(() => {
  if (!loaded || !dirty) return;
  const timer = setTimeout(async () => {
    // PUT latestRef.current
    // On response: setState((prev) => ({...prev, updated_at: response.updated_at}))
    // — only the timestamp, never the matrix/games/etc., so in-flight edits aren't blat'd
  }, 700);
  return () => clearTimeout(timer);
}, [state, dirty, loaded]);
```

The ref-pattern is load-bearing — without it, the save would serialise a
stale snapshot when the user kept editing during the debounce window.

### Roster filtering
The full 32-player history in `snapshot.players` is too long for daily use.
Filtered via `getActiveRoster()` (auto: played in `latestSeason` + ≥25 career
PA) or `applyRosterOverrides()` (auto-active ∪ `lineup.added` − `lineup.archived`).

The override fields live on the shared `Lineup` so manual archive/add
decisions propagate to the night planner automatically.

### Position alignments (9-player vs 10-player)
Slo-pitch is 10 fielders standard. When attendance is 9, drop one CF (storage:
LCF; UI label: "CF"). Auto-picked from attendee count via
`modeForAttendeeCount()`. `POSITIONS_BY_MODE.nine` excludes RCF entirely.

The lineup-suggest API accepts the mode (explicit or inferred) and tells
Claude which keys to emit; output is validated against the active set so a
stray "RCF" in 9p mode gets dropped silently.

### Smart fill (Claude-driven lineup)
The greedy "Suggest fill" button is gone. The **🐝 Generate both games**
button on the LineupBuilder fires two sequential POSTs to `/api/lineup/suggest`:
1. Game 1: empty `prior_game`, fresh fill
2. Game 2: passes Game 1's `innings` as `prior_game` so rotation notes
   ("rotate pitchers next game", "split catchers across games") resolve

Both calls share the same cached system prompt (one per mode). Subsequent
clicks within ~5 min hit the cache.

### Theme
- Background: `bg-amber-50/30` + subtle honeycomb SVG tiled via data-URI in
  `app/layout.tsx` (`stroke-opacity='0.06'`, fixed-attachment).
- Primary: `bg-amber-700` / `text-amber-900`. Nav active state: `bg-amber-900 text-amber-50`.
- Pill states (LineupGrid): grey (`bg-stone-100`) → amber (`bg-amber-300`) → emerald (`bg-emerald-500`).
- Runner squares (Diamond): `#b45309` (amber-700), white stroke.
- Beeves bubble: amber-700 user, stone-50 assistant.

### "Server-only" imports
Two modules guard against client-bundle leaks: `lib/claude.ts` and
`lib/data-server.ts` both import `"server-only"`. Never `import` them from a
`"use client"` file.

### Prompt caching
All three Claude touchpoints rely on prompt caching. See
[../docs/CLAUDE_INTEGRATIONS.md](../docs/CLAUDE_INTEGRATIONS.md) for the
per-route breakdown.

---

## Common operations

### Add a new field to the snapshot
1. Update `build_data_json.py` to compute and emit it.
2. Run `python build_data_json.py` to regenerate `web/public/data/snapshot.json`.
3. Add the field to the relevant type in `lib/data.ts`.
4. Use it in the consuming component.
5. Commit both the Python change and the regenerated JSON.

### Add a new API route
1. Create `app/api/<name>/route.ts`. Export `GET` / `POST` / etc.
2. Add `export const runtime = "nodejs"` (always).
3. Add `export const dynamic = "force-dynamic"` if the response shouldn't be cached.
4. Use `getRedis()` from `lib/lineup.ts` or `lib/night.ts` for KV access.
5. Use `getAnthropic()` from `lib/claude.ts` for Claude calls. Always handle the `null` case (env not configured) by returning 503.

### Add a new Claude call
- Default to `MODELS.default` (Sonnet 4.6).
- If the prompt has a stable prefix and varying suffix, mark the last stable
  block with `cache_control: {type: "ephemeral"}` for caching.
- Streaming preferred for chat / long output. Use `anthropic.messages.stream()`
  with `for await (const event of stream)` and `stream.finalMessage()`.
- Document the new touchpoint in `docs/CLAUDE_INTEGRATIONS.md`.

### Make a UI change
- Mobile-first. 44×44 minimum tap targets. Test at iPhone width.
- Use existing amber palette unless there's a clear reason to add a new color.
- Auto-save the change — never add a Save button.
- If the component touches `Lineup` or `PersistedNight`, the parent does the
  PUT; child components just call `onChange` with the new state.

---

## Things that don't exist (and why)

- **`/ask` page** — removed; Beeves is now a floating widget on every page.
- **Deep Mode toggle** — removed; always Sonnet 4.6. Adding it back means
  exposing `MODELS.smart` (Opus 4.7) via a query param.
- **Save buttons** — removed everywhere; auto-save is universal.
- **Authentication** — none. The site is public. Anyone with the URL can
  edit the shared lineup notes / per-night data. Acceptable risk for a
  10-person team; revisit if this expands.
- **Per-player notes** — collapsed into a single team-wide `team_notes` block
  on the Lineup blob. Beeves reads this for Smart fill.
- **Greedy lineup fill** — the local greedy algorithm is gone from the UI;
  the function still exists in `LineupBuilder.tsx` (`suggestFill()`) as a
  reference but isn't called.
