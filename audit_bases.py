"""
Audit the runners_before / runners_after fields for impossible base states:
the same player on two bases at once.

Output: how many at-bats have a duplicated runner, per season, plus a few
example offenders to help debug the root cause.
"""
from __future__ import annotations
import json
import os
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(HERE, "web", "public", "data", "snapshot.json")


def dup_names(state: dict) -> list[str]:
    """Return the names that appear on more than one base in this state."""
    if not state:
        return []
    seen: dict[str, int] = {}
    for b in ("1", "2", "3"):
        n = state.get(b)
        if not n:
            continue
        seen[n] = seen.get(n, 0) + 1
    return [n for n, c in seen.items() if c >= 2]


def main():
    snap = json.load(open(SNAP, encoding="utf-8"))
    at_bats = snap["at_bats"]

    n_before_dup = 0
    n_after_dup = 0
    n_total_with_runners = 0
    by_season_before = Counter()
    by_season_after = Counter()
    by_season_total = Counter()
    examples: list[dict] = []

    for ab in at_bats:
        before = ab.get("runners_before") or {}
        after = ab.get("runners_after") or {}
        yr = ab.get("season_year") or 0
        any_runner = any(before.values()) or any(after.values())
        if any_runner:
            n_total_with_runners += 1
            by_season_total[yr] += 1
        bd = dup_names(before)
        ad = dup_names(after)
        if bd:
            n_before_dup += 1
            by_season_before[yr] += 1
        if ad:
            n_after_dup += 1
            by_season_after[yr] += 1
        if (bd or ad) and len(examples) < 12:
            examples.append({
                "date": ab.get("date"),
                "batter": ab.get("batter"),
                "result": ab.get("result"),
                "before": before,
                "after": after,
                "moves": ab.get("runner_moves"),
                "before_dups": bd,
                "after_dups": ad,
                "event_id": (ab.get("event_id") or "")[:8],
                "seq": ab.get("transaction_seq"),
            })

    print(f"At-bats with any runner-state present: {n_total_with_runners}")
    print(f"At-bats with DUPED runner_before:      {n_before_dup}  ({n_before_dup*100/max(n_total_with_runners,1):.1f}% of those)")
    print(f"At-bats with DUPED runner_after:       {n_after_dup}  ({n_after_dup*100/max(n_total_with_runners,1):.1f}%)")
    print()
    print(f"{'SEASON':<8} {'WITH_RUNNERS':>13} {'DUP_BEFORE':>11} {'DUP_AFTER':>10}")
    for yr in sorted(by_season_total):
        print(f"{yr:<8} {by_season_total[yr]:>13} {by_season_before[yr]:>11} {by_season_after[yr]:>10}")
    print()
    print("Examples (first 12):")
    for e in examples:
        print(f"  {e['date']}  {e['batter']:<15} {e['result']:<25}  before={e['before']}  after={e['after']}")
        if e["moves"]:
            print(f"     moves={e['moves']}")
        if e["before_dups"]:
            print(f"     dups_before={e['before_dups']}")
        if e["after_dups"]:
            print(f"     dups_after={e['after_dups']}")


if __name__ == "__main__":
    main()
