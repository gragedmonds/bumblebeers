"""
Emit web/public/data/snapshot.json — the data payload the Next.js app reads.

This replaces the HTML-baking step of build_rankings_html.py. Same data shape
(players / career_weighted / weights / at_bats / mvp_nights), different sink.

Re-run after build_excel.py + build_rankings.py whenever you re-scrape:

    python build_excel.py
    python build_rankings.py
    python build_data_json.py
"""
from __future__ import annotations
import json
import math
import os
import sys

# Reuse every builder from the legacy HTML emitter — same maths, same aliases.
from build_rankings_html import (
    load_pergame_bundle,
    build_players_map,
    build_at_bats,
    build_mvp_nights,
    pk,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "web", "public", "data")
OUT = os.path.join(OUT_DIR, "snapshot.json")


def scrub(o):
    """Recursively replace NaN/Inf with None so the JSON is pure (no bare NaN tokens)."""
    if isinstance(o, float):
        if math.isnan(o) or math.isinf(o):
            return None
        return o
    if isinstance(o, dict):
        return {k: scrub(v) for k, v in o.items()}
    if isinstance(o, list):
        return [scrub(v) for v in o]
    return o


def main():
    bundle = load_pergame_bundle()
    by_player = build_players_map(bundle)
    career_weighted = {pk(c["display_name"]): c for c in bundle["career_weighted"]}
    at_bats = build_at_bats()
    mvp_nights = build_mvp_nights(at_bats)

    payload = scrub({
        "generated_at": _now_iso(),
        "players": by_player,
        "career_weighted": career_weighted,
        "weights": bundle["weights"],
        "at_bats": at_bats,
        "mvp_nights": mvp_nights,
    })

    os.makedirs(OUT_DIR, exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, allow_nan=False, separators=(",", ":"))

    size_kb = round(os.path.getsize(OUT) / 1024)
    print(
        f"wrote {OUT} "
        f"({size_kb} KB, "
        f"{len(at_bats)} at-bats, "
        f"{len(mvp_nights)} MVP nights, "
        f"{len(by_player)} players)"
    )


def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


if __name__ == "__main__":
    sys.exit(main())
