// Build the system prompt for /api/ask. The first block is a frozen
// instruction header; the second block is the static stats payload baked
// from snapshot.json. Both stay byte-identical between requests so the
// `cache_control` breakpoint on the second block hits prompt-cache reads
// on every request after the first.

import "server-only";
import { loadSnapshot } from "./data-server";
import type { Snapshot, MvpLine, MvpNight } from "./data";

const INSTRUCTIONS = `You are "the Bee" — an analyst for the Bumblebeers, an adult slo-pitch softball team in Whitby, Ontario. You answer questions about the team's stats using the data block below.

Rules:
- Cite numbers from the data when possible; never invent stats Claude doesn't see.
- Treat the season-stats numbers as authoritative for HR / RBI totals (GameChanger's play-by-play undercounts HRs in older seasons; the official season-stats endpoint is the source of truth for season totals).
- The MVP-night data is derived from play-by-play only — it's accurate for recent seasons (2024+) and best-effort for older ones.
- If a question requires data you don't have (e.g. per-pitch breakdowns, per-game opposing-team stats), say so plainly — don't fabricate.
- Keep answers short by default; expand only when the question warrants it.
- Use plain text formatting. Markdown tables are fine for leaderboards.

The BMBL+ score (composite ranking, 100 = team-season average, 25 = 1 stddev):
  BMBL+ = 100 + 25 * Σ(weight_i × z_score_i)
  Tiers (weights): Production wOBA 40%, Power ISO 10%, Clutch RISP 10%, Clutch 2-out RBI 8%, Clutch Productive-out 7%, Discipline K-avoidance 5%, Discipline BB 5%, Discipline QAB 5%, Contact hard-contact 6%, Contact line-drive 4%.
  Min 25 PA to qualify. Bayesian shrinkage on wOBA only (k=50 PA toward season mean).

The MVP-night score (per-night Tall-Can recipient):
  score = TB×1.5 + runs_scored×1.2 + HR×1.5 + XBH×0.8 + SF×0.5 − outs×0.4
  Min 2 PAs to qualify for a night's MVP. Tie-break: TB → H → fewer outs.`;

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
