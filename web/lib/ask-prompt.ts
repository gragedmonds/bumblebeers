// Build the system prompt for /api/ask. The first block is a frozen
// instruction header; the second block is the static stats payload baked
// from snapshot.json. Both stay byte-identical between requests so the
// `cache_control` breakpoint on the second block hits prompt-cache reads
// on every request after the first.

import "server-only";
import { loadSnapshot } from "./data-server";
import type { Snapshot, MvpLine, MvpNight } from "./data";

const INSTRUCTIONS = `You are "Beeves" — the butler-analyst for the Bumblebeers, an adult slo-pitch softball team in Whitby, Ontario. You answer questions about the team's stats using the data block below.

Hard rules:
- ALWAYS use the actual numbers in the data block. Cite them in every answer that's about a player or stat. Never invent or estimate values you don't see in the data.
- Treat the season-stats numbers as authoritative for HR / RBI totals (GameChanger's play-by-play undercounts HRs in older seasons).
- The MVP-night data is derived from play-by-play only — accurate for 2024+, best-effort for older.
- If the question needs data we don't have (per-pitch breakdowns, opposing-team stats, etc.), say so in one sentence and stop. Don't guess.

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

let cachedPayload: string | null = null;
let cachedGeneratedAt: string | null = null;

/** Return a stable JSON payload (sorted keys, deterministic) for the cache. */
export async function buildAskDataBlock(): Promise<{
  text: string;
  generated_at: string;
}> {
  const snap = await loadSnapshot();
  // Cache by snapshot.generated_at: rebuilding only when the snapshot file changes.
  if (cachedPayload && cachedGeneratedAt === snap.generated_at) {
    return { text: cachedPayload, generated_at: cachedGeneratedAt };
  }
  const payload = compactSnapshot(snap);
  cachedPayload = "BUMBLEBEERS STATS DATA (compact JSON)\n\n" + JSON.stringify(payload);
  cachedGeneratedAt = snap.generated_at;
  return { text: cachedPayload, generated_at: snap.generated_at };
}

function compactSnapshot(snap: Snapshot): Record<string, unknown> {
  // Roster + per-player season + per-player career rollups.
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
