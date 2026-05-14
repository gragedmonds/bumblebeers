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

    # ---------- 5. Per-season cross-check: at-bat counts vs SEASON_STATS truth -----
    # The snapshot already has the authoritative stats baked in under
    # `players[key].seasons[i].stats`. Use those as ground truth and compare
    # against what we counted from the at-bats list.
    print("=" * 70)
    print("Per-season cross-check: PBP counts vs authoritative SEASON_STATS")
    print("=" * 70)
    pbp_by_season: dict[int, Counter] = defaultdict(Counter)
    for ab in snap["at_bats"]:
        yr = ab.get("season_year") or 0
        r = ab.get("result")
        if r == "home_run":
            pbp_by_season[yr]["HR"] += 1
        if r in {"single", "double", "triple", "home_run"}:
            pbp_by_season[yr]["H"] += 1
            pbp_by_season[yr][{"single": "1B", "double": "2B", "triple": "3B", "home_run": "HR"}[r]] += 1
    truth_by_season: dict[int, Counter] = defaultdict(Counter)
    for key, p in snap["players"].items():
        for s in p.get("seasons") or []:
            yr = s.get("season_year")
            stats = s.get("stats") or {}
            if not stats:
                continue
            for k in ("PA", "AB", "H", "1B", "2B", "3B", "HR", "SO", "BB", "HBP", "RBI"):
                truth_by_season[yr][k] += int(stats.get(k) or 0)
    all_years = sorted(set(pbp_by_season) | set(truth_by_season))
    print(f"{'SEASON':<8} {'PBP_H':>6} {'TRUE_H':>7} {'GAP_H':>6}   {'PBP_HR':>7} {'TRUE_HR':>8} {'GAP':>5}   {'TRUE_SO':>8} {'TRUE_BB':>8}")
    print("-" * 90)
    for yr in all_years:
        if yr == 0:
            continue
        p_h = pbp_by_season[yr]["H"]
        t_h = truth_by_season[yr]["H"]
        p_hr = pbp_by_season[yr]["HR"]
        t_hr = truth_by_season[yr]["HR"]
        t_so = truth_by_season[yr]["SO"]
        t_bb = truth_by_season[yr]["BB"]
        print(f"{yr:<8} {p_h:>6} {t_h:>7} {t_h - p_h:>+6}   {p_hr:>7} {t_hr:>8} {t_hr - p_hr:>+5}   {t_so:>8} {t_bb:>8}")
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
