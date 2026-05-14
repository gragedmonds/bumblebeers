"""Audit at-bat coverage.

Compares the raw play stream against the processed at-bats in
web/public/data/snapshot.json. Prints:

  1. Raw transaction counts by result-type (truth from GameChanger).
  2. Snapshot counts by result-type.
  3. Per-result delta (raw_bb - snapshot) — the gap.
  4. Per-season breakdown of missing rows.

A raw half-inning is treated as Bumblebees if at least one of its
transactions made it into the snapshot. Within those half-innings, any
transaction whose (event_id, sequence_number) is NOT in the snapshot
counts as missing.

Run after each snapshot rebuild:

    python build_data_json.py
    python audit_atbats.py
"""
from __future__ import annotations
import json
import os
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "gamechanger_bumblebeers_raw.json")
SNAP = os.path.join(HERE, "web", "public", "data", "snapshot.json")


def main():
    raw = json.load(open(RAW, encoding="utf-8"))
    snap = json.load(open(SNAP, encoding="utf-8"))

    snap_results = Counter(a.get("result") or "(none)" for a in snap["at_bats"])
    snap_seqs = set((a.get("event_id"), a.get("transaction_seq")) for a in snap["at_bats"])
    snap_ab_by_game_year: dict[str, int] = {}
    for a in snap["at_bats"]:
        eid = a.get("event_id")
        if eid:
            snap_ab_by_game_year[eid] = int(a.get("season_year") or 0)

    raw_results_all: Counter[str] = Counter()
    raw_results_bb: Counter[str] = Counter()
    missing_results: Counter[str] = Counter()
    missing_by_season: defaultdict[int, Counter[str]] = defaultdict(Counter)
    bb_raw_total = 0

    for t in raw.get("teams", []):
        for g in t.get("games") or []:
            eid = ((g.get("schedule_entry") or {}).get("event") or {}).get("id")
            if not eid:
                continue
            year = snap_ab_by_game_year.get(eid, 0)

            # First pass: assign each play to a raw_half_idx (0-indexed),
            # incremented on every end_half event.
            plays = sorted(
                g.get("plays") or [], key=lambda p: p.get("sequence_number", 0)
            )
            decoded: list[tuple[int, str, dict, int]] = []  # seq, code, ed, half_idx
            half_idx = -1
            for p in plays:
                try:
                    ed = json.loads(p["event_data"])
                except Exception:
                    continue
                code = ed.get("code") or ""
                if code == "end_half":
                    half_idx += 1
                    continue
                decoded.append(
                    (int(p.get("sequence_number") or 0), code, ed, max(half_idx, 0))
                )

            # Second pass: mark raw half-innings that have at least one
            # snapshot transaction as Bumblebees.
            bb_halves: set[int] = set()
            for seq, code, _ed, h in decoded:
                if code == "transaction" and (eid, seq) in snap_seqs:
                    bb_halves.add(h)

            # Third pass: count raw_results_all and missing-from-snapshot in
            # Bumblebees half-innings. Skip non-AB transactions (lineup
            # setup, substitutions, base-running-only steals) — those have
            # no ball_in_play sub-event and shouldn't be in the at-bats log
            # anyway.
            for seq, code, ed, h in decoded:
                if code != "transaction":
                    continue
                pr = None
                for sub in ed.get("events") or []:
                    if sub.get("code") == "ball_in_play":
                        pr = (sub.get("attributes") or {}).get("playResult") or "(unknown)"
                        break
                if pr is None:
                    continue  # admin transaction, not an at-bat
                raw_results_all[pr] += 1
                if h not in bb_halves:
                    continue
                bb_raw_total += 1
                raw_results_bb[pr] += 1
                if (eid, seq) not in snap_seqs:
                    missing_results[pr] += 1
                    if year:
                        missing_by_season[year][pr] += 1

    print(f"Snapshot at-bats:                              {len(snap['at_bats'])}")
    print(f"Raw transactions in Bumblebees half-innings:   {bb_raw_total}")
    print(f"Missing-from-snapshot in those half-innings:   {sum(missing_results.values())}")
    print()
    print(
        f"{'result':<40} {'raw_all':>8} {'raw_bb':>8} {'snapshot':>10} {'missing':>9}"
    )
    print("-" * 78)
    all_results = sorted(
        set(
            list(raw_results_all.keys())
            + list(raw_results_bb.keys())
            + list(snap_results.keys())
            + list(missing_results.keys())
        ),
        key=lambda r: -(raw_results_bb.get(r, 0) + snap_results.get(r, 0)),
    )
    for r in all_results:
        print(
            f"{r:<40} "
            f"{raw_results_all.get(r, 0):>8} "
            f"{raw_results_bb.get(r, 0):>8} "
            f"{snap_results.get(r, 0):>10} "
            f"{missing_results.get(r, 0):>9}"
        )

    if missing_by_season:
        print()
        print("Missing-from-snapshot by season:")
        for y in sorted(missing_by_season):
            total = sum(missing_by_season[y].values())
            top = missing_by_season[y].most_common(3)
            print(
                f"  {y}: {total:>3} missing  "
                + "  ".join(f"{n} {r}" for r, n in top)
            )


if __name__ == "__main__":
    main()
