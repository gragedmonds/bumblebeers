"""
Cross-check what we have against authoritative sources.

Three counts get compared per season + per result type:
  1. RAW         — Bumblebees transactions in gamechanger_bumblebeers_raw.json
                   (filtered by half-inning parity matching known Bumblebees ABs)
  2. XLSX        — rows in bumblebeers_gamechanger.xlsx AtBats sheet
  3. SNAPSHOT    — at_bats array in web/public/data/snapshot.json
  4. SEASON_STATS — authoritative per-player HR / hit totals from the
                    /season-stats API endpoint (gamechanger_season_stats.json)

Discrepancies tell us where to dig.

Usage:  python audit_completeness.py
"""
from __future__ import annotations
import json
import os
from collections import Counter, defaultdict
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "gamechanger_bumblebeers_raw.json")
XLSX = os.path.join(HERE, "bumblebeers_gamechanger.xlsx")
SNAPSHOT = os.path.join(HERE, "web", "public", "data", "snapshot.json")
SEASON_STATS = os.path.join(HERE, "gamechanger_season_stats.json")


def main():
    raw = json.load(open(RAW, encoding="utf-8"))
    snap = json.load(open(SNAPSHOT, encoding="utf-8"))
    xlsx = pd.read_excel(XLSX, sheet_name="AtBats")
    season_stats = (
        json.load(open(SEASON_STATS, encoding="utf-8"))
        if os.path.exists(SEASON_STATS)
        else None
    )

    print("=" * 70)
    print("Bumblebeers data completeness audit")
    print("=" * 70)
    print()

    # ---------- 1. Identify Bumblebees half-innings from snapshot ----------
    # The snapshot's at_bats have half_inning_id of form `{event_id}:{half_idx}`.
    # Any half_inning_id appearing in the snapshot is by definition a
    # Bumblebees offensive half-inning.
    known_bb_hii: set[str] = set()
    for ab in snap["at_bats"]:
        hii = ab.get("half_inning_id")
        if hii:
            known_bb_hii.add(hii)

    # For each game we also infer the Bumblebees half-inning parity, so we
    # can pick up Bumblebees innings that have ZERO surviving ABs in the
    # snapshot (would be missed by the hii-set above).
    bb_parity_by_game: dict[str, set[int]] = {}
    for hii in known_bb_hii:
        eid, half = hii.rsplit(":", 1)
        try:
            h = int(half)
        except ValueError:
            continue
        bb_parity_by_game.setdefault(eid, set()).add(h % 2)

    # ---------- 2. Walk raw plays, count Bumblebees transactions ----------
    raw_result_counts: Counter = Counter()
    raw_result_by_season: dict[int, Counter] = defaultdict(Counter)
    raw_total_by_game = 0
    snapshot_seqs: set[tuple] = {
        (ab.get("event_id"), int(ab.get("transaction_seq") or 0))
        for ab in snap["at_bats"]
    }
    missing_in_snapshot: Counter = Counter()
    missing_by_season: dict[int, Counter] = defaultdict(Counter)

    for t in raw.get("teams", []):
        for g in t.get("games", []) or []:
            entry = g.get("schedule_entry") or {}
            event_obj = entry.get("event") or {}
            eid = event_obj.get("id")
            start = event_obj.get("start")
            # `start` is { datetime: "YYYY-MM-DDTHH:MM:SSZ" }
            if isinstance(start, dict):
                start_str = start.get("datetime") or start.get("date") or ""
            else:
                start_str = str(start or "")
            try:
                season = int(start_str[:4])
            except (ValueError, TypeError):
                season = 0
            plays = sorted(
                g.get("plays") or [], key=lambda p: p.get("sequence_number", 0)
            )
            half_idx = -1
            parities = bb_parity_by_game.get(eid, set())
            # If the game has NO snapshot ABs at all we can't infer parity —
            # skip the whole game rather than risk counting opposing-team
            # transactions as Bumblebees.
            if not parities:
                continue
            for p in plays:
                try:
                    ed = json.loads(p["event_data"])
                except Exception:
                    continue
                code = ed.get("code")
                if code == "end_half":
                    half_idx += 1
                    continue
                if code != "transaction":
                    continue
                # Only Bumblebees half-innings.
                if half_idx % 2 not in parities:
                    continue
                # Extract result from nested ball_in_play
                pr = None
                for sub in ed.get("events") or []:
                    if sub.get("code") == "ball_in_play":
                        pr = (sub.get("attributes") or {}).get("playResult")
                        break
                raw_result_counts[pr or "(none)"] += 1
                raw_result_by_season[season][pr or "(none)"] += 1
                raw_total_by_game += 1
                seq = int(p.get("sequence_number") or 0)
                if (eid, seq) not in snapshot_seqs:
                    missing_in_snapshot[pr or "(none)"] += 1
                    missing_by_season[season][pr or "(none)"] += 1

    # ---------- 3. Snapshot + XLSX counts (already in memory) -------------
    snap_results = Counter(a.get("result") or "(none)" for a in snap["at_bats"])
    xlsx_results = Counter(xlsx["result"].fillna("(none)").tolist())

    # ---------- 4. Print summary table -----------------------------------
    print(f"Bumblebees half-innings detected: {len(known_bb_hii)} (across {len(bb_parity_by_game)} games)")
    print(f"Raw transactions in those innings: {raw_total_by_game}")
    print(f"XLSX AtBats rows:                  {len(xlsx)}")
    print(f"Snapshot at_bats rows:             {len(snap['at_bats'])}")
    print()

    print(f"{'RESULT':<35} {'RAW':>6} {'XLSX':>6} {'SNAP':>6} {'MISSING':>8}")
    print("-" * 70)
    all_results = set(raw_result_counts) | set(xlsx_results) | set(snap_results)
    for r in sorted(all_results, key=lambda x: -raw_result_counts.get(x, 0)):
        a = raw_result_counts.get(r, 0)
        b = xlsx_results.get(r, 0)
        c = snap_results.get(r, 0)
        miss = missing_in_snapshot.get(r, 0)
        print(f"{r:<35} {a:>6} {b:>6} {c:>6} {miss:>8}")
    print()

    # ---------- 5. Per-season HR cross-check -----------------------------
    if season_stats:
        print("=" * 70)
        print("Per-season HR cross-check (SEASON_STATS = authoritative)")
        print("=" * 70)
        # snap → group HRs by season + player
        snap_hr_by_season_player: dict[tuple[int, str], int] = defaultdict(int)
        for ab in snap["at_bats"]:
            if ab.get("result") == "home_run":
                snap_hr_by_season_player[(ab["season_year"], ab.get("batter") or "?")] += 1
        # season_stats — find per-player HR
        # Structure: list of season records keyed by display_name + season_year
        truth_hr_by_season_player: dict[tuple[int, str], int] = defaultdict(int)
        for rec in season_stats if isinstance(season_stats, list) else season_stats.get("stats", []):
            try:
                yr = int(rec.get("season_year") or 0)
                name = rec.get("display_name") or "?"
                hr = int(rec.get("HR") or rec.get("hr") or 0)
                if hr > 0:
                    truth_hr_by_season_player[(yr, name)] += hr
            except (ValueError, TypeError):
                continue
        # Total per season
        truth_total_by_season: Counter = Counter()
        for (yr, _), n in truth_hr_by_season_player.items():
            truth_total_by_season[yr] += n
        snap_total_by_season: Counter = Counter()
        for (yr, _), n in snap_hr_by_season_player.items():
            snap_total_by_season[yr] += n
        all_years = sorted(set(truth_total_by_season) | set(snap_total_by_season))
        print(f"{'SEASON':<8} {'SNAPSHOT_HR':>12} {'TRUTH_HR':>10} {'GAP':>6}")
        print("-" * 40)
        for yr in all_years:
            s = snap_total_by_season.get(yr, 0)
            t = truth_total_by_season.get(yr, 0)
            print(f"{yr:<8} {s:>12} {t:>10} {t - s:>+6}")
    print()

    # ---------- 6. Per-season transactions missing from snapshot ---------
    print("=" * 70)
    print("Bumblebees raw transactions MISSING from snapshot, by season + result")
    print("=" * 70)
    print(f"{'SEASON':<8} {'RESULT':<35} {'COUNT':>6}")
    print("-" * 56)
    for yr in sorted(missing_by_season):
        for r, n in missing_by_season[yr].most_common():
            if n:
                print(f"{yr:<8} {r:<35} {n:>6}")
    print()
    print(f"TOTAL missing: {sum(missing_in_snapshot.values())}")


if __name__ == "__main__":
    main()
