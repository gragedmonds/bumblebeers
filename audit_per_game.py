"""
Per-game coverage audit: how many games have play-by-play data vs how many
games went into season-stats? If a chunk of games have NO plays at all, the
50% per-season gap is a coverage issue, not a parsing bug.
"""
from __future__ import annotations
import json
import os
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "gamechanger_bumblebeers_raw.json")
SEASON_STATS = os.path.join(HERE, "gamechanger_season_stats.json")


def _yr(start) -> int:
    if isinstance(start, dict):
        s = start.get("datetime") or start.get("date") or ""
    else:
        s = str(start or "")
    try:
        return int(s[:4])
    except ValueError:
        return 0


def main():
    raw = json.load(open(RAW, encoding="utf-8"))

    by_season_total = Counter()
    by_season_with_plays = Counter()
    by_season_completed = Counter()
    by_season_with_plays_and_completed = Counter()
    plays_per_game: list[tuple[int, str, int, str]] = []  # (season, status, n_plays, eid)

    for t in raw.get("teams", []):
        for g in t.get("games", []) or []:
            entry = g.get("schedule_entry") or {}
            ev = entry.get("event") or {}
            eid = ev.get("id")
            yr = _yr(ev.get("start"))
            status = ev.get("status") or ""
            plays = g.get("plays") or []
            n_plays = len(plays)
            by_season_total[yr] += 1
            if n_plays > 0:
                by_season_with_plays[yr] += 1
            if status.upper() in ("COMPLETED", "FINAL", "PLAYED", "ENDED"):
                by_season_completed[yr] += 1
                if n_plays > 0:
                    by_season_with_plays_and_completed[yr] += 1
            plays_per_game.append((yr, status, n_plays, eid or ""))

    print(f"{'YEAR':<6} {'GAMES':>6} {'COMPLETED':>10} {'WITH_PLAYS':>11} {'BOTH':>6}")
    for yr in sorted(by_season_total):
        if yr == 0:
            continue
        print(f"{yr:<6} {by_season_total[yr]:>6} {by_season_completed[yr]:>10} {by_season_with_plays[yr]:>11} {by_season_with_plays_and_completed[yr]:>6}")
    print()
    print("Game statuses seen across raw:")
    status_counts = Counter(s for _, s, _, _ in plays_per_game)
    for s, n in status_counts.most_common():
        print(f"  {s or '(empty)':<20} {n}")
    print()
    print("Plays-per-game distribution (only games with plays):")
    buckets = Counter()
    for yr, status, n, _ in plays_per_game:
        if n == 0:
            continue
        if n < 20:
            buckets[f"{yr}: <20 plays"] += 1
        elif n < 100:
            buckets[f"{yr}: 20-99"] += 1
        elif n < 300:
            buckets[f"{yr}: 100-299"] += 1
        else:
            buckets[f"{yr}: 300+"] += 1
    for k in sorted(buckets):
        print(f"  {k:<30} {buckets[k]}")
    print()
    print("Suspiciously low plays (under 50, completed games):")
    low = [(yr, s, n, eid) for yr, s, n, eid in plays_per_game if 0 < n < 50 and s.upper() in ("COMPLETED", "FINAL", "ENDED")]
    for yr, s, n, eid in sorted(low)[:25]:
        print(f"  {yr}  status={s}  plays={n}  eid={eid}")
    print(f"... ({len(low)} total)")


if __name__ == "__main__":
    main()
