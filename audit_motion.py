"""
Consistency audit for per-AB motion.

For every at-bat we check:
  1. Every `runner_moves` entry's `from` matches who was on that base in
     `runners_before` (with `from=0` meaning the batter, who shouldn't be on base).
  2. Every `to=1|2|3` lands the runner on the matching base in `runners_after`.
  3. `runs_scored` equals the count of `to=4` moves (or +1 if the batter
     went home on a HR).
  4. Runners on base in `before` who DON'T appear in `moves` should still
     be in `after` on the same or a later base.
"""
from __future__ import annotations
import json
import os
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(HERE, "web", "public", "data", "snapshot.json")


def main():
    snap = json.load(open(SNAP, encoding="utf-8"))
    at_bats = snap["at_bats"]

    bad_from = 0  # move's `from` doesn't match before-state
    bad_to = 0    # move's `to` doesn't match after-state
    bad_runs = 0  # runs_scored != count(to=4)
    ghost_runner = 0  # in before, not in moves, not in after
    n_with_motion = 0
    bad_examples: list[dict] = []

    for ab in at_bats:
        before = ab.get("runners_before") or {}
        after = ab.get("runners_after") or {}
        moves = ab.get("runner_moves") or []
        result = ab.get("result")
        runs = ab.get("runs_scored") or 0
        batter = ab.get("batter")

        if not moves and not any(before.values()) and not any(after.values()):
            continue
        n_with_motion += 1

        problems: list[str] = []

        # 1. from-state matches before
        for m in moves:
            nm = m.get("name")
            fr = m.get("from")
            if fr in (1, 2, 3):
                if before.get(str(fr)) != nm:
                    problems.append(f"from-mismatch: {nm} from={fr} but before[{fr}]={before.get(str(fr))}")
                    bad_from += 1
            elif fr == 0:
                # batter — shouldn't be on any base in before
                for b in ("1", "2", "3"):
                    if before.get(b) == nm:
                        problems.append(f"batter-on-base: {nm} listed from=0 but on base {b} in before")
                        bad_from += 1
                        break

        # 2. to-state matches after
        for m in moves:
            nm = m.get("name")
            to = m.get("to")
            if to in (1, 2, 3):
                if after.get(str(to)) != nm:
                    problems.append(f"to-mismatch: {nm} to={to} but after[{to}]={after.get(str(to))}")
                    bad_to += 1

        # 3. runs_scored
        scored_in_moves = sum(1 for m in moves if m.get("to") == 4)
        if result == "home_run" and not any(m.get("name") == batter and m.get("to") == 4 for m in moves):
            # HR with batter implicit — add 1
            scored_in_moves += 1
        if runs != scored_in_moves:
            # Acceptable mismatch: HR batter might already be in moves array
            problems.append(f"runs={runs} but moves shows {scored_in_moves} scored")
            bad_runs += 1

        # 4. Ghost runners: in before, not in moves, not in after
        moved_names = {m.get("name") for m in moves}
        for b in ("1", "2", "3"):
            nm = before.get(b)
            if not nm:
                continue
            if nm in moved_names:
                continue
            # should still be on a base in after (same or higher)
            still_there = any(after.get(b2) == nm for b2 in ("1", "2", "3"))
            if not still_there:
                problems.append(f"ghost: {nm} on base {b} in before, no move logged, gone in after")
                ghost_runner += 1
                break

        if problems and len(bad_examples) < 10:
            bad_examples.append({
                "date": ab.get("date"),
                "batter": batter,
                "result": result,
                "before": before,
                "after": after,
                "moves": moves,
                "problems": problems,
            })

    print(f"At-bats with motion data: {n_with_motion}")
    print(f"Move from-state mismatches:   {bad_from}")
    print(f"Move to-state mismatches:     {bad_to}")
    print(f"runs_scored mismatches:       {bad_runs}")
    print(f"Ghost runners (gone, no move):{ghost_runner}")
    print()
    print("Examples:")
    for e in bad_examples:
        print(f"  {e['date']}  {e['batter']:<15} {e['result']}")
        print(f"     before={e['before']}  after={e['after']}")
        print(f"     moves={e['moves']}")
        for p in e['problems']:
            print(f"     ! {p}")


if __name__ == "__main__":
    main()
