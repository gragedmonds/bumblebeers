# Claude API integrations

The Bumblebeers app makes three distinct Claude calls. Each lives in its own
route handler, each has a specific caching strategy. This doc explains what
each does, why it's shaped the way it is, and where the prompt-caching
breakpoints land.

**Default model:** `claude-sonnet-4-6` (`MODELS.default` in `lib/claude.ts`).
**Opus 4.7** (`MODELS.smart`) is defined but not currently exposed in any UI.
Deep Mode was removed at Greg's request.

**Env requirement:** `ANTHROPIC_API_KEY` set in Vercel. When absent, every
route returns 503 with `{error: "anthropic_not_configured"}` and the UI
shows a friendly message. The SDK client is lazy-inited in `getAnthropic()`
so a missing key never crashes the route handler at module load.

---

## Touchpoint 1: Beeves chat — `/api/ask`

**File:** `web/app/api/ask/route.ts`
**UI:** floating button in `web/app/components/AskBeeves.tsx` opens an
inline panel that streams responses here.
**Streaming:** Server-Sent Events. The client reads `event: text`,
`event: done`, `event: error` frames.

### Request body

```ts
{
  question: string;                                    // ≤ 4000 chars
  history?: { role: "user" | "assistant"; content: string }[];  // last 12 turns kept
}
```

### System prompt structure

Two blocks. The first is a tight instruction set (Beeves persona, formatting
rules, two reference formulas). The second is the **compact stats payload**
baked from `snapshot.json` — players + season + career rollups + MVP nights,
~150-250 KB of JSON.

```
system[0]: instructions (small, ~1.5 KB)
system[1]: data block (~150-250 KB)  ← cache_control: ephemeral here
```

The `cache_control` breakpoint is on the **last** system block. Render
order is `tools` → `system` → `messages`, so this caches everything in the
prefix (no tools used here). The data block stays byte-identical between
deploys (it's keyed by `snapshot.generated_at`), so reads hit cache.

### Cache economics

| Tier | Cost ratio | When |
|---|---|---|
| Cache write | ~1.25× input | First request after a deploy / after the 5-min TTL lapses |
| Cache read | ~0.1× input | Every subsequent request within 5 min |
| Uncached | 1× | The varying suffix only (the question + recent history) |

The data block is ~50-80K tokens. At Sonnet 4.6 input rate of $3/MTok:
- **Cold (first ask):** ~$0.20 (one-time)
- **Warm (next ask in 5 min):** ~$0.02

For typical bursty usage (someone opens the panel, asks several questions
in a row), this is fine. If traffic is sparse (single questions hours
apart), consider switching to `ttl: "1h"` on the cache_control (cost 2× on
writes, but the cache lives longer).

### Formatting rules (in the system prompt)

- Leaderboards / multi-player comparisons → markdown table
- Single-stat lookups → lead with `**bolded answer**`, one sentence of context
- Trends → small markdown table or bulleted list
- ALWAYS cite numbers from the data block; never invent stats
- No preambles ("Great question!", "Based on the data...")
- Tone: dry, wry "butler" persona

These rules are embedded in `INSTRUCTIONS` in `lib/ask-prompt.ts`. Update
that file (not the route) to tune Beeves's voice.

### Streaming idiom (route side)

```ts
const sdkStream = anthropic.messages.stream({
  model: "claude-sonnet-4-6",
  max_tokens: 4096,
  system,
  messages,
});

for await (const event of sdkStream) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    send("text", { delta: event.delta.text });
  }
}
const final = await sdkStream.finalMessage();
send("done", { model, stop_reason: final.stop_reason, usage: { ... } });
```

The client (AskBeeves.tsx) parses SSE manually — no EventSource (because we
POST, not GET). Reads `r.body.getReader()`, decodes chunks, splits on `\n\n`,
parses each frame.

### Conversation state

Module-scope variable in `AskBeeves.tsx`: `let cachedThread: Turn[] = []`.
Closing/reopening the panel preserves the thread; full page reload drops it.
This is intentional — no per-user persistence, matches the rest of the app's
read-only-public stance.

History is capped at 12 turns server-side before being sent to Claude (the
`MAX_HISTORY_TURNS` constant in the route).

---

## Touchpoint 2: Attendance OCR — `/api/attendance/parse`

**File:** `web/app/api/attendance/parse/route.ts`
**UI:** "Upload poll screenshot" button in `web/components/AttendanceEditor.tsx`
on the per-night page.
**Streaming:** No. Single request, single response.

### Request body

```ts
{
  image_base64: string;                                    // capped at ~14 MB
  image_media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  self_key?: string;  // optional: which roster key "You" in the screenshot maps to
}
```

### Response body

```ts
{
  in:  { key: string; display_name: string; raw: string }[];
  out: { key: string; display_name: string; raw: string }[];
  unmatched_in:  string[];  // names Claude saw but didn't match any roster key
  unmatched_out: string[];
  model: string;
}
```

### Model + technique

Vision-mode Sonnet 4.6 via `extractAttendeesFromImage()` in `lib/claude.ts`.
The prompt:

1. Includes the **active roster** inline (canonical key + display name pairs),
   composed from `snapshot.players` + `lineup.added` (so brand-new manually-
   added players match too).
2. Asks Claude to OCR the screenshot AND match each name to a roster key in
   the same call.
3. Returns `{in: [{key, raw}], out: [{key, raw}]}` with `key: null` for any
   name Claude saw but couldn't match.

This is a deliberate departure from the older "OCR then fuzzy-match
server-side" pattern — Claude handles nickname pairs (Tyler / Ty, Michael /
Mikey, David / Davey) natively instead of us maintaining an alias table.

Common nickname pairs are listed in the prompt to nudge Claude in the right
direction:

```
Michael / Mike / Mikey
Tyler / Ty
David / Dave / Davey
Jonathan / Jon / Johnny
Christopher / Chris
Robert / Rob / Bob
Matthew / Matt
```

### Why no caching here

Every screenshot is unique input, so there's no stable prefix to cache. The
roster block is small (~30 lines), so the prompt overhead is negligible
anyway. Per-call cost is ~$0.02 (input dominated by the image + roster
prompt).

### Server-side roster composition

Done in the route handler before calling Claude:

```ts
const baseRoster = await loadRoster();              // snapshot.json players
const rosterByKey = new Map(baseRoster.map((p) => [p.key, p.display_name]));
const stored = await redis.get<Lineup>(LINEUP_KEY);
for (const a of (stored?.added ?? [])) {
  if (!rosterByKey.has(a.key)) rosterByKey.set(a.key, a.display_name);
}
const roster = [...rosterByKey.entries()].map(([key, display_name]) => ({ key, display_name }));
```

Result: a player Greg manually added via the LineupGrid "+Add player" form
is recognised in screenshot uploads on the next night.

### Validation

The response from Claude is parsed leniently (markdown fences are stripped,
`{...}` substring extracted if the first parse fails). Any key Claude
returns that isn't in `rosterByKey` is silently demoted to `unmatched_*`.

---

## Touchpoint 3: Smart fill — `/api/lineup/suggest`

**File:** `web/app/api/lineup/suggest/route.ts`
**UI:** "🐝 Generate both games" button in `web/components/LineupBuilder.tsx`.
**Streaming:** No.

### Request body

```ts
{
  attendees:    { key: string; name: string }[];                          // ≥ 9 required
  prefs:        Record<person_key, Partial<Record<Pos, "can" | "should">>>;  // matrix from /api/lineup
  team_notes:   string;
  game_num:     1 | 2;
  opponent?:    string;
  mode?:        "ten" | "nine";   // inferred from attendee count if absent
  existing?:    InningLineup[8];  // locked partial assignments (don't overwrite)
  prior_game?:  InningLineup[8];  // game 1's result when generating game 2
}
```

### Response body

```ts
{
  innings: InningLineup[8];
  explanation: string;            // 1-3 sentences naming the constraints applied
  mode: "ten" | "nine";
  model: string;
  usage: {
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
  };
}
```

### Mode awareness

`POSITIONS_BY_MODE.ten` = `[1B, 2B, 3B, SS, P, C, LF, LCF, RCF, RF]`
`POSITIONS_BY_MODE.nine` = `[1B, 2B, 3B, SS, P, C, LF, LCF, RF]` (LCF reads as "CF" in the UI)

The route uses these to:
1. Filter the per-attendee preference summary (skip RCF entirely in 9p mode).
2. Tell Claude which keys it's allowed to emit.
3. Validate the response — keys outside the active alignment are dropped
   silently (so a stray "RCF" in 9p mode won't sneak in).

### System prompt

Single text block, `INSTRUCTIONS_BASE`. Includes the hard rules (one player
per position per inning, no double-booking) and soft rules (honour
team_notes, prefer "should" > "can" > other, spread innings).

The mode-specific position list isn't in the system block — it goes in the
**user prompt** because it varies per request. That means the system block
stays stable across modes and prompt caching can land.

```
system[0] (cacheable): hard + soft rules, output format
user: mode description + position list + attendee block + team_notes + prior_game? + existing?
```

`cache_control: ephemeral` on `system[0]`. After the first call in a 5-min
window, every subsequent call (even across modes) hits the cache.

### The "Generate both games" flow

Triggered by one button click. Client-side in `LineupBuilder.tsx`:

```ts
const g1 = await callSuggest({ ...shared, game_num: 1 });
const g2 = await callSuggest({ ...shared, game_num: 2, prior_game: g1.innings });
```

Game 2's `prior_game` field is what makes notes like *"rotate pitchers next
game"* and *"split catchers across games"* resolve correctly. Without it,
Claude has no way to know what was in game 1.

The system prompt is identical across the two calls (modes are the same for
a given night), so call 2 hits cache from call 1's write. Total cost per
generate-both: ~$0.03 (call 1 writes ~1.25× ~$0.02; call 2 reads ~0.1× +
~10K tokens of varying user prompt + output).

### Cost per click

| Scenario | Cost |
|---|---|
| First click after a deploy | ~$0.03 (game 1 cache-writes, game 2 cache-reads) |
| Second click within 5 min | ~$0.01 (both calls cache-read) |
| Cache miss recovery (rare) | up to ~$0.06 |

This is well within hobby-app territory.

### Output validation

Claude's response is parsed leniently (markdown fences stripped, first `{}` block extracted on parse failure). Per-inning output is filtered:

```ts
for (const pos of positions) {  // active alignment only
  const v = src[pos];
  if (typeof v === "string" && v && attendeeKeys.has(v)) {
    row[pos] = v;
  }
}
```

Effects:
- Unknown position keys are dropped.
- Player keys not in the attendee list are dropped (leaves the cell empty).
- Claude can mark a cell as `null` and we respect it (still empty in the
  output — surfaces in the UI as "—" in the dropdown).

---

## Comparing the three integrations

| Aspect | Beeves (/api/ask) | Attendance (/api/attendance/parse) | Suggest (/api/lineup/suggest) |
|---|---|---|---|
| **Streaming** | Yes (SSE) | No | No |
| **Cache strategy** | Big static data block at the end of system | None (each image is unique) | Stable instructions in system; varying user |
| **Cache size** | ~50-80K tokens | ~500 tokens | ~600 tokens |
| **Typical cost / call** | $0.02 warm, $0.20 cold | $0.02 | $0.01-0.03 |
| **Output parsing** | Markdown rendering client-side | Strict JSON | Lenient JSON + validation |
| **Model** | Sonnet 4.6 | Sonnet 4.6 (vision) | Sonnet 4.6 |
| **Used by** | Chat panel on every page | AttendanceEditor (one route) | LineupBuilder (one route) |

---

## Adding a fourth touchpoint

If you add a new Claude call, follow this checklist:

1. **Decide on caching.** Is there a stable prefix that's worth caching?
   - Stable ≥1024 tokens (Sonnet 4.6 min cacheable size) → mark the last
     stable block with `cache_control: {type: "ephemeral"}`.
   - Sub-1024 → don't bother, the cache silently won't fire anyway.
2. **Decide on streaming.** Long output / chat-style UX → stream via SSE.
   Short structured output (JSON) → single request/response.
3. **Use `getAnthropic()`** from `lib/claude.ts`. Always handle the `null`
   return value with a 503 response.
4. **Pick the model from `MODELS`.** Don't hardcode model strings — when we
   upgrade Sonnet, one constant changes.
5. **Type the request + response bodies.** Use the body interface idiom seen
   in the existing routes (`SuggestBody`, `ParseBody`, `AskBody`).
6. **Validate the response** before trusting it. Don't pass model-generated
   keys through unchecked — `attendeeKeys.has(v)` and friends.
7. **Document it here.** Add a Touchpoint N section with body schema,
   prompt structure, caching strategy, and cost notes.
8. **Anthropic SDK docs in tree.** Reference symbols live at
   `web/node_modules/@anthropic-ai/sdk/`. If you need a binding not used
   elsewhere, WebFetch the official SDK docs first (Next.js 16's runtime is
   stricter than older versions).

---

## Cost dashboard quick reference

A typical week:
- 2 nights × 2 Generate-both clicks (one for game-1+2, one to retry after edits) = ~$0.12
- 5 chat questions × 1 cache hit each = ~$0.10
- 1 attendance screenshot per night × 2 nights = ~$0.04

**~$1/month** at current usage. Bumping volumes 10× still stays under
$15/month. Cache_read tier is doing the heavy lifting.

Verify cache hits in production by inspecting `response.usage.cache_read_input_tokens`
in the Vercel logs — it should be >0 after the first request on any
cold-deployed route.
