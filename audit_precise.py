"""
Precise audit: walk the raw play stream using build_excel.GameState logic
(end_half + 3-out fallback) and identify every BMBL offensive transaction.
Compare against:
  - XLSX AtBats sheet (what build_excel emitted)
  - snapshot.at_bats (what build_data_json emitted, incl. synthetic walks/Ks)
  - season-stats truth (per-player offense totals)

Surfaces where the gap actually lives.
"""
from __future__ import annotations
import json
import os
from collections import Counter, defaultdict
import pandas as pd

from build_excel import GameState, _OUT_PLAY_RESULTS, _OUT_BASERUN_TYPES

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "gamechanger_bumblebeers_raw.json")
XLSX = os.path.join(HERE, "bumblebeers_gamechanger.xlsx")
SNAP = os.path.join(HERE, "web", "public", "data", "snapshot.json")


def _local_date(start) -> str:
    if isinstance(start, dict):
        s = start.get("datetime") or start.get("date") or ""
    else:
        s = str(start or "")
    return s[:4]


def precise_walk(raw):
    """Yield one record per BMBL offense transaction.

    Mimics build_excel.build_event_rows exactly: same GameState, same
    is_atbat condition (`inner_pitches and (play_result or extended)`).
    Also yields transactions in BMBL frames that *would* be dropped
    by is_atbat — so we can see what gets filtered.
    """
    for t in raw.get("teams", []):
        tm = t["team_meta"]
        for g in t.get("games", []) or []:
            entry = g.get("schedule_entry") or {}
            ev = entry.get("event") or {}
            eid = ev.get("id")
            pre = entry.get("pregame_data") or {}
            home_away = pre.get("home_away")
            sy_str = _local_date(ev.get("start"))
            try:
                season = int(sy_str)
            except ValueError:
                season = 0

            gs = GameState(owning_team_id=tm["id"], home_away=home_away)
            plays = sorted(g.get("plays") or [], key=lambda p: p.get("sequence_number", 0))
            for p in plays:
                try:
                    ed = json.loads(p["event_data"])
                except Exception:
                    continue
                code = ed.get("code")
                gs.maybe_auto_flip(code)
                if code == "transaction":
                    inner_pitches = []
                    play_result = None
                    extended_play_result = None
                    inner_baserun = []
                    for sub in ed.get("events", []) or []:
                        sc = sub.get("code")
                        sa = sub.get("attributes") or {}
                        if sc == "pitch":
                            inner_pitches.append(sa.get("result"))
                        elif sc == "ball_in_play":
                            play_result = sa.get("playResult")
                            extended_play_result = sa.get("extendedPlayResult")
                        elif sc == "base_running":
                            inner_baserun.append(sub)
                        if sc in ("fill_lineup_index", "fill_lineup", "goto_lineup_index",
                                  "clear_lineup_index", "clear_entire_lineup", "sub_players"):
                            gs.apply_event(sub)
                    is_atbat = bool(inner_pitches and (play_result or extended_play_result))
                    yield {
                        "season": season,
                        "event_id": eid,
                        "seq": int(p.get("sequence_number") or 0),
                        "bmbl_offense": gs.bmbl_offense,
                        "is_atbat": is_atbat,
                        "has_pitches": bool(inner_pitches),
                        "play_result": play_result,
                        "extended": extended_play_result,
                    }
                    if is_atbat:
                        gs.register_at_bat(play_result or extended_play_result, inner_baserun)
                else:
                    gs.apply_event(ed)


def main():
    raw = json.load(open(RAW, encoding="utf-8"))
    xlsx = pd.read_excel(XLSX, sheet_name="AtBats")
    snap = json.load(open(SNAP, encoding="utf-8"))

    bmbl_real = Counter()
    bmbl_pitchless = Counter()        # transaction in BMBL half, but no pitches
    bmbl_no_result = Counter()        # has pitches but no playResult — gets dropped
    opp_real = Counter()
    per_season_bmbl_real = defaultdict(Counter)
    per_season_dropped = defaultdict(Counter)
    games_seen = set()

    for r in precise_walk(raw):
        games_seen.add(r["event_id"])
        if r["bmbl_offense"]:
            if r["is_atbat"]:
                bmbl_real[r["play_result"] or "(none)"] += 1
                per_season_bmbl_real[r["season"]][r["play_result"] or "(none)"] += 1
            elif not r["has_pitches"]:
                bmbl_pitchless["(no pitches)"] += 1
                per_season_dropped[r["season"]]["(no pitches)"] += 1
            else:
                bmbl_no_result["(no playResult)"] += 1
                per_season_dropped[r["season"]]["(no playResult)"] += 1
        else:
            if r["is_atbat"]:
                opp_real[r["play_result"] or "(none)"] += 1

    xlsx_results = Counter(xlsx["result"].fillna("(none)").tolist())
    snap_results = Counter(a.get("result") or "(none)" for a in snap["at_bats"])

    print(f"Games walked:    {len(games_seen)}")
    print(f"BMBL is_atbat:   {sum(bmbl_real.values())}  (this is what xlsx should have)")
    print(f"BMBL dropped:    pitchless={sum(bmbl_pitchless.values())}, no_result={sum(bmbl_no_result.values())}")
    print(f"Opponent ABs:    {sum(opp_real.values())}  (correctly excluded)")
    print(f"XLSX rows:       {len(xlsx)}")
    print(f"Snapshot rows:   {len(snap['at_bats'])}")
    print()
    print(f"{'RESULT':<35} {'BMBL_RAW':>9} {'XLSX':>6} {'SNAP':>6}")
    print("-" * 60)
    all_r = set(bmbl_real) | set(xlsx_results) | set(snap_results)
    for r in sorted(all_r, key=lambda x: -bmbl_real.get(x, 0)):
        a = bmbl_real.get(r, 0)
        b = xlsx_results.get(r, 0)
        c = snap_results.get(r, 0)
        print(f"{r:<35} {a:>9} {b:>6} {c:>6}")
    print()

    print("Per-season BMBL real-AB vs season-stats truth")
    print("-" * 70)
    truth = defaultdict(Counter)
    for key, p in snap["players"].items():
        for s in p.get("seasons") or []:
            yr = s.get("season_year")
            st = s.get("stats") or {}
            if not st:
                continue
            for k in ("PA", "AB", "H", "HR", "1B", "2B", "3B", "BB", "SO", "HBP"):
                truth[yr][k] += int(st.get(k) or 0)
    snap_hr_by_season = defaultdict(int)
    snap_h_by_season = defaultdict(int)
    snap_bb_by_season = defaultdict(int)
    snap_so_by_season = defaultdict(int)
    snap_ab_by_season = defaultdict(int)
    snap_pa_by_season = defaultdict(int)
    for ab in snap["at_bats"]:
        yr = ab.get("season_year") or 0
        r = ab.get("result")
        snap_pa_by_season[yr] += 1
        if r in {"single", "double", "triple", "home_run"}:
            snap_h_by_season[yr] += 1
            snap_ab_by_season[yr] += 1
        elif r == "walk":
            snap_bb_by_season[yr] += 1
        elif r == "strike_out":
            snap_so_by_season[yr] += 1
            snap_ab_by_season[yr] += 1
        else:
            # other_out / batter_out / etc. count as ABs (sac fly + walks don't)
            if r not in {"sacrifice_fly", "sacrifice_fly_error"}:
                snap_ab_by_season[yr] += 1
        if r == "home_run":
            snap_hr_by_season[yr] += 1

    print(f"{'YEAR':<6} {'PA_PBP':>7} {'PA_T':>6} {'AB_PBP':>7} {'AB_T':>6} {'H_PBP':>6} {'H_T':>5} {'HR_PBP':>7} {'HR_T':>5} {'BB_PBP':>7} {'BB_T':>5} {'SO_PBP':>7} {'SO_T':>5}")
    for yr in sorted(truth):
        if yr == 0:
            continue
        print(f"{yr:<6} {snap_pa_by_season[yr]:>7} {truth[yr]['PA']:>6} {snap_ab_by_season[yr]:>7} {truth[yr]['AB']:>6} {snap_h_by_season[yr]:>6} {truth[yr]['H']:>5} {snap_hr_by_season[yr]:>7} {truth[yr]['HR']:>5} {snap_bb_by_season[yr]:>7} {truth[yr]['BB']:>5} {snap_so_by_season[yr]:>7} {truth[yr]['SO']:>5}")
    print()
    print("BMBL dropped transactions by season + reason:")
    for yr in sorted(per_season_dropped):
        for reason, n in per_season_dropped[yr].most_common():
            print(f"  {yr}  {reason:<25}  {n}")


if __name__ == "__main__":
    main()
