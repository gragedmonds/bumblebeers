// Build the system prompt for /api/ask. The first block is a frozen
// instruction header; the second block is the static stats payload baked
// from snapshot.json. Both stay byte-identical between requests so the
// `cache_control` breakpoint on the second block hits prompt-cache reads
// on every request after the first.

import "server-only";
import { loadSnapshot } from "./data-server";
import type { AtBat, Snapshot, MvpLine, MvpNight } from "./data";

const INSTRUCTIONS = `You are "Beeves" — the butler-analyst for the Bumblebeers, an adult slo-pitch softball team in Whitby, Ontario. You answer questions about the team's stats using the data block below.

Data inventory (read this carefully — it's the difference between answering and refusing):

  TWO sources of player offense data sit side-by-side in the SUMMARY block:

    (1) players[key].seasons[i] — each season has PA + wOBA + BMBL_plus
        plus a "stats" object with AUTHORITATIVE season totals from
        GameChanger's season-stats endpoint: PA, AB, H, 1B, 2B, 3B, HR,
        TB, BB, SO, HBP, SF, FC, ROE, R, RBI, SB, CS, AVG, OB.

        THIS IS WHERE YOU FIND STRIKEOUTS, WALKS, AND HBPs.
        THIS IS THE TRUE HR COUNT (older seasons' pbp HR counts are
        undercount and unreliable).

    (2) AT_BATS log (TSV at the bottom of the block, ~5,371 rows) —
        every plate appearance where the BALL WAS PUT IN PLAY. Used for
        per-AB / per-day / per-opponent / per-play-type / per-spray /
        RISP questions.

        The AT_BATS log does NOT contain strikeouts, walks, or
        hit-by-pitches. GameChanger's scorers do not log balls and
        strikes pitch-by-pitch; they only record what happened when the
        ball was hit. For any of those outcomes, you can only answer at
        the season-total level using players[key].seasons[i].stats.

  career_weighted[key] — career BMBL+ rollup; use it for career-level
  BMBL+ leaderboards.

  mvp_nights — per-night MVP picks for the Tall Can award.

Hard rules:
- ALWAYS use the actual numbers in the data block. Cite them in every answer that's about a player or stat. Never invent or estimate values.
- For HR / RBI / SO / BB / HBP totals, use players[key].seasons[i].stats — those numbers come from GameChanger's authoritative season-stats endpoint.
- For per-at-bat / per-day / per-opponent / per-play-type / RISP questions, query the AT_BATS TSV directly. Filter, group, and count in your head — no tool calls.
- The AT_BATS log is play-by-play and undercounts HRs in older seasons (the scorers were terse). For HR LEADERBOARDS specifically, use seasons[i].stats.HR, NOT a count from AT_BATS.
- The MVP-night data is derived from play-by-play only — accurate for 2024+, best-effort for older.
- Per-AB strikeout/walk/HBP questions ("who struck out the most on Tuesday") can NOT be answered. Per-season strikeout totals CAN. Say so explicitly when this matters: "Per-AB strikeout context isn't logged — here are season totals instead:" then show the table.
- The only things genuinely missing: per-pitch breakdowns, opposing-team box scores, weather. If a question needs those, say so in one sentence and stop.

Output formatting (this matters — readers are tapping this on a phone):
- For ANY ranking / leaderboard / top-N question, return a markdown table. Columns should be the names + the stat(s) being compared, rounded sensibly (BMBL+ to 1 decimal, wOBA to 3 decimals, percentages with a %). Limit tables to ≤10 rows unless asked otherwise; if there are more, show the top and note the count.
- For a single-stat lookup ("what's Greg's career BMBL+?"), lead with **the bolded number**, then one short sentence of context.
- For trends across seasons, use a small table with one row per season.
- For comparisons between 2-4 players, use a side-by-side table.
- Use **bold** for the headline number, never for whole sentences.
- Keep tables compact — short column headers, no decoration.
- Total response budget: aim for under 8 lines unless the question genuinely needs more. If it doesn't fit, prefer a sharper answer over a longer one.
- No preamble like "Great question!" or "Here is...". Lead with the answer.

Two reference formulas you can quote when relevant:

BMBL+ (composite ranking, 100 = team-season average, 25 = 1 stddev):
  BMBL+ = 100 + 25 × Σ(weight_i × z_score_i)
  Weights: wOBA 40%, ISO 10%, RISP_diff 10%, 2-out RBI 8%, productive-out 7%, K-avoidance 5%, BB 5%, QAB 5%, hard-contact 6%, line-drive 4%.
  Min 25 PA to qualify. Bayesian shrinkage on wOBA only (k=50 PA toward season mean).

MVP-night score (per-night Tall Can):
  score = TB×1.5 + runs_scored×1.2 + HR×1.5 + XBH×0.8 + SF×0.5 − outs×0.4
  Min 2 PAs to qualify. Tie-break: TB → H → fewer outs.`;

/**
 * Trim the MVP nights list down to the fields the model actually needs to
 * answer questions. Cuts payload by ~40% versus stuffing the full
 * snapshot.mvp_nights array verbatim — the `top` array has 5 entries with
 * a dozen fields each; we only need MVP + runner-up.
 */
function compactMvp(nights: MvpNight[]): Array<Record<string, unknown>> {
  return nights.map((n) => ({
    date: n.date,
    season: n.season_year,
    opponents: n.opponents,
    mvp: compactLine(n.mvp),
    runner_up: n.runner_up ? compactLine(n.runner_up) : null,
    justification: n.justification,
  }));
}

function compactLine(p: MvpLine): Record<string, unknown> {
  return {
    name: p.display_name,
    score: p.score,
    PA: p.PA,
    AB: p.AB,
    H: p.H,
    HR: p.HR,
    TB: p.TB,
    XBH: p.XBH,
    runs: p.runs_scored,
    outs: p.outs,
  };
}

// Compact every at-bat into one pipe-delimited row. Token-efficient for
// the data block — TSV reads cheaper than JSON when there are thousands of
// near-identical records. Includes everything needed for typical per-AB
// questions (day-of-week breakdowns, opponent splits, RISP, play-type
// patterns). Excludes coordinates (x/y) and explicit runner_moves to keep
// the block under control — those live in snapshot.json for the spray
// chart but aren't useful for natural-language Q&A.
function compactAtBats(at_bats: AtBat[]): string {
  const header =
    "AT_BATS TSV — every plate appearance 2018–2025. Columns (pipe-delimited):\n" +
    "date|person_key|result|play_type|runs_scored|opponent|season|zone|side|risp\n" +
    "  date         YYYY-MM-DD (America/Toronto local)\n" +
    "  person_key   canonical key (also used in players block)\n" +
    "  result       single|double|triple|home_run|strike_out|batter_out|batter_out_advance_runners|infield_fly|other_out|dropped_third_strike_batter_out|sacrifice_fly|fielders_choice|error\n" +
    "  play_type    line_drive|fly_ball|ground_ball|hard_ground_ball|pop_fly|bunt|other  (may be blank)\n" +
    "  runs_scored  RBIs credited to this AB (incl. the batter if HR)\n" +
    "  zone         infield|outfield|other\n" +
    "  side         left|middle|right|other\n" +
    "  risp         1 if any runner was on 2B or 3B before the pitch, else 0\n";
  const rows: string[] = [];
  for (const ab of at_bats) {
    const rb = ab.runners_before;
    const risp = rb && (rb["2"] || rb["3"]) ? 1 : 0;
    rows.push(
      [
        ab.date ?? "",
        ab.person_key ?? "",
        ab.result ?? "",
        ab.play_type ?? "",
        ab.runs_scored ?? 0,
        ab.opponent ?? "",
        ab.season_year ?? "",
        ab.field_zone ?? "",
        ab.field_side ?? "",
        risp,
      ].join("|"),
    );
  }
  return header + rows.join("\n");
}

let cachedPayload: string | null = null;
let cachedGeneratedAt: string | null = null;

/** Return a stable text payload (deterministic) for the cache. */
export async function buildAskDataBlock(): Promise<{
  text: string;
  generated_at: string;
}> {
  const snap = await loadSnapshot();
  // Cache by snapshot.generated_at: rebuilding only when the snapshot file changes.
  if (cachedPayload && cachedGeneratedAt === snap.generated_at) {
    return { text: cachedPayload, generated_at: cachedGeneratedAt };
  }
  const summaryJson = JSON.stringify(compactSnapshot(snap));
  const atBatsTsv = compactAtBats(snap.at_bats);
  cachedPayload =
    "BUMBLEBEERS STATS DATA\n\n" +
    "==== SUMMARY (compact JSON: players + seasons + career rollups + MVP nights) ====\n" +
    summaryJson +
    "\n\n==== AT_BATS LOG ====\n" +
    atBatsTsv;
  cachedGeneratedAt = snap.generated_at;
  return { text: cachedPayload, generated_at: snap.generated_at };
}

function compactSnapshot(snap: Snapshot): Record<string, unknown> {
  // Roster + per-player season + per-player career rollups. The `stats`
  // sub-object on each season is the authoritative season-stats payload
  // (SO/BB/HBP/HR/etc.) — surfacing it here means Beeves can answer
  // "career strikeouts" / "most HRs in 2024" without us having to compute.
  const players: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(snap.players)) {
    players[key] = {
      name: p.display_name,
      seasons: (p.seasons || []).map((s) => ({
        year: s.season_year,
        PA: s.PA,
        wOBA: s.wOBA,
        BMBL_plus: s.BMBL_plus,
        qualified: s.qualified,
        stats: s.stats ?? null,
      })),
    };
  }
  return {
    generated_at: snap.generated_at,
    bmbl_weights: snap.weights,
    players,
    career_weighted: snap.career_weighted,
    mvp_nights: compactMvp(snap.mvp_nights),
  };
}

export function instructions(): string {
  return INSTRUCTIONS;
}
