"""
Emit web/public/data/snapshot.json — the data payload the Next.js app reads.

This replaces the HTML-baking step of build_rankings_html.py. Same data shape
(players / career_weighted / weights / at_bats / mvp_nights), different sink,
plus a Phase 3 enrichment: `runners_before` on every at-bat, derived by
walking the raw play stream.

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
from collections import defaultdict

# Reuse every builder from the legacy HTML emitter — same maths, same aliases.
from build_rankings_html import (
    load_pergame_bundle,
    build_players_map,
    build_at_bats,
    build_mvp_nights,
    pk,
)

HERE = os.path.dirname(os.path.abspath(__file__))
RAW_JSON = os.path.join(HERE, "gamechanger_bumblebeers_raw.json")
OUT_DIR = os.path.join(HERE, "web", "public", "data")
OUT = os.path.join(OUT_DIR, "snapshot.json")

# Play-result strings that imply the batter ends up at a specific base when not out.
# Used by the runners-on-base tracker to advance untagged runners on hits.
_BATTER_LANDS_AT = {
    "single": 1,
    "double": 2,
    "triple": 3,
    "home_run": 4,
    "walk": 1,
    "hit_by_pitch": 1,
    "fielders_choice": 1,
    "error": 1,
}
# Default runner advancement (bases) when no explicit base_running event tags the runner.
_RUNNER_ADVANCE_FOR = {
    "single": 1,
    "double": 2,
    "triple": 3,
    "home_run": 4,
    "walk": 0,         # only forced runners advance; we let explicit base_running events handle it
    "hit_by_pitch": 0,
}


def _build_player_id_map(raw) -> dict[str, str]:
    """player_id (UUID) → display name (first name), across every team-season."""
    out: dict[str, str] = {}
    for t in raw.get("teams", []):
        for p in t.get("players") or []:
            pid = p.get("id") or p.get("player_id")
            name = p.get("first_name") or p.get("display_name") or p.get("last_name") or ""
            if pid and name:
                out[pid] = name.strip()
    return out


def _extract_play_result(event_data: dict) -> str | None:
    """Pull the playResult string out of a transaction's nested events.

    Real at-bat transactions wrap a `pitch` → `ball_in_play` chain whose
    attributes carry the high-level outcome (single / double / batter_out
    / etc). Lineup-update transactions don't have one — that's the signal we
    use to ignore them when computing runner state.
    """
    for sub in event_data.get("events") or []:
        attrs = sub.get("attributes") or {}
        v = attrs.get("playResult")
        if isinstance(v, str) and v:
            return v
        for sub2 in sub.get("events") or []:
            a2 = sub2.get("attributes") or {}
            v = a2.get("playResult")
            if isinstance(v, str) and v:
                return v
    return None


def _walk_lineup_subs(event_data: dict):
    """Yield (sub_code, sub_attrs) for each fill_lineup_index / goto_lineup_index
    that lives nested inside a lineup-update transaction's events array.
    """
    for sub in event_data.get("events") or []:
        code = sub.get("code")
        if code in ("fill_lineup_index", "goto_lineup_index"):
            yield code, sub.get("attributes") or {}


def _compute_runners_before(raw, player_id_map):
    """Walk the play stream and produce, for each transaction, the names of any
    runners standing on 1B / 2B / 3B just before that transaction fires.

    Returns: dict keyed by (event_id, transaction_sequence_number) →
             {"1": name|None, "2": name|None, "3": name|None}

    Approach: scan every game's plays in `sequence_number` order; maintain a
    `bases` dict {1: runner_id|None, 2: …, 3: …} that resets on `end_half`.
    For each `transaction` we snapshot bases (that is the BEFORE state), then
    apply both the explicit follow-up `base_running` events and a play-result
    heuristic so the next transaction sees a roughly-correct AFTER state.

    Coverage: known to be imperfect for older seasons where scorers were terse
    (CLAUDE.md "play-by-play is incomplete for historical seasons"). For the
    visual it's plenty — and we never invent runners, only place ones the
    play stream already named.
    """
    out: dict[tuple[str, int], dict[str, str | None]] = {}

    for t in raw.get("teams", []):
        for g in t.get("games") or []:
            eid = ((g.get("schedule_entry") or {}).get("event") or {}).get("id")
            plays = sorted(g.get("plays") or [], key=lambda p: p.get("sequence_number", 0))

            # Pre-decode every play once; group base_running events by the most
            # recent transaction sequence so we can apply them after snapshotting.
            decoded: list[tuple[int, str, dict]] = []
            for p in plays:
                try:
                    ed = json.loads(p["event_data"])
                except Exception:
                    continue
                decoded.append((int(p.get("sequence_number") or 0), ed.get("code") or "", ed))

            bases: dict[int, str | None] = {1: None, 2: None, 3: None}
            last_tx_seq: int | None = None
            last_tx_result: str | None = None
            # Cache batter id so we can advance bases after a transaction once
            # the follow-up base_running events have fired.
            last_tx_batter: str | None = None
            # Buffer base_running events for the current transaction.
            pending_brs: list[dict] = []

            def flush_pending():
                """Apply pending base_running events + play-result heuristic to bases."""
                nonlocal bases
                if last_tx_seq is None:
                    pending_brs.clear()
                    return
                explicit_runners: set[str] = set()
                # 1) Process explicit base_running events from the play stream.
                # Each one explicitly moves a named runner to a new base (or out).
                next_bases: dict[int, str | None] = {1: None, 2: None, 3: None}
                for ev in pending_brs:
                    rid = ev.get("runnerId")
                    base = ev.get("base")
                    pt = (ev.get("playType") or "").lower()
                    if not rid:
                        continue
                    explicit_runners.add(rid)
                    if "out" in pt:
                        continue  # runner is out; doesn't end up on a base
                    if base in (1, 2, 3) and next_bases[base] is None:
                        next_bases[base] = rid
                    # base == 4 → scored; runner leaves the basepaths
                # 2) Untagged runners advance by the play-result default.
                advance_n = _RUNNER_ADVANCE_FOR.get(last_tx_result or "", 0)
                for b in (1, 2, 3):
                    rid = bases.get(b)
                    if rid is None or rid in explicit_runners:
                        continue
                    new_b = b + advance_n
                    if 1 <= new_b <= 3 and next_bases[new_b] is None:
                        next_bases[new_b] = rid
                    # new_b == 4 → scored; new_b == 0/<0 impossible
                # 3) Place the batter from the prior transaction.
                if last_tx_batter and last_tx_result:
                    target = _BATTER_LANDS_AT.get(last_tx_result)
                    if target in (1, 2, 3) and next_bases[target] is None:
                        next_bases[target] = last_tx_batter
                bases = next_bases
                pending_brs.clear()

            # Track lineup state per team so we can identify the batter at each
            # at-bat. GameChanger uses `fill_lineup_index` (slot assignments) and
            # `goto_lineup_index` (current pointer); these arrive both at TOP
            # level (early-game setup) and NESTED inside "lineup-update"
            # transactions (in-game pointer advancement after each at-bat).
            lineup_slot: dict[str, dict[int, str]] = defaultdict(dict)
            lineup_idx: dict[str, int] = defaultdict(int)
            # The team that's currently batting — most recent team whose lineup
            # pointer moved (or whose slot was filled).
            current_offense_team: str | None = None

            def apply_fill(a: dict):
                tid = a.get("teamId")
                idx = a.get("index")
                pid = a.get("playerId")
                if tid and pid and isinstance(idx, int):
                    lineup_slot[tid][idx] = pid
                return tid

            def apply_goto(a: dict):
                tid = a.get("teamId")
                idx = a.get("index")
                if tid and isinstance(idx, int):
                    lineup_idx[tid] = idx
                return tid

            for seq, code, ed in decoded:
                attrs = ed.get("attributes") or {}
                if code == "fill_lineup_index":
                    tid = apply_fill(attrs)
                    if tid:
                        current_offense_team = tid
                elif code == "goto_lineup_index":
                    tid = apply_goto(attrs)
                    if tid:
                        current_offense_team = tid
                elif code == "transaction":
                    play_result = _extract_play_result(ed)
                    if play_result:
                        # REAL at-bat. Finalize any prior runner motion, then snapshot.
                        flush_pending()
                        out[(eid, seq)] = {
                            "1": player_id_map.get(bases[1]) if bases[1] else None,
                            "2": player_id_map.get(bases[2]) if bases[2] else None,
                            "3": player_id_map.get(bases[3]) if bases[3] else None,
                        }
                        # Identify the batter via the offense team's lineup pointer.
                        batter_id = None
                        if current_offense_team and current_offense_team in lineup_slot:
                            slots = lineup_slot[current_offense_team]
                            ix = lineup_idx.get(current_offense_team, 0)
                            batter_id = slots.get(ix) or slots.get(ix % max(len(slots), 1))
                        last_tx_seq = seq
                        last_tx_result = play_result
                        last_tx_batter = batter_id
                    else:
                        # LINEUP-UPDATE transaction: walk its nested events and
                        # update lineup state, but DO NOT snapshot or flush.
                        for sub_code, sub_attrs in _walk_lineup_subs(ed):
                            if sub_code == "fill_lineup_index":
                                tid = apply_fill(sub_attrs)
                                if tid:
                                    current_offense_team = tid
                            elif sub_code == "goto_lineup_index":
                                tid = apply_goto(sub_attrs)
                                if tid:
                                    current_offense_team = tid
                elif code == "base_running":
                    if last_tx_seq is not None:
                        pending_brs.append(attrs)
                elif code == "end_half":
                    # Apply pending events for the inning's final at-bat, then
                    # wipe bases. New half, fresh paths.
                    flush_pending()
                    bases = {1: None, 2: None, 3: None}
                    last_tx_seq = None
                    last_tx_result = None
                    last_tx_batter = None
            # End of game: flush any trailing pending events (defensive).
            flush_pending()
    return out


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

    # Phase 3 enrichment: attach `runners_before` per at-bat by walking the raw play stream.
    if os.path.exists(RAW_JSON):
        with open(RAW_JSON, "r", encoding="utf-8") as f:
            raw = json.load(f)
        player_id_map = _build_player_id_map(raw)
        runners_before = _compute_runners_before(raw, player_id_map)
        hits = 0
        for ab in at_bats:
            key = (ab.get("event_id"), ab.get("transaction_seq"))
            rb = runners_before.get(key)
            if rb is None:
                ab["runners_before"] = {"1": None, "2": None, "3": None}
            else:
                ab["runners_before"] = rb
                if any(rb.values()):
                    hits += 1
        print(f"runners_before: matched {hits}/{len(at_bats)} at-bats with at least one runner on")
    else:
        for ab in at_bats:
            ab["runners_before"] = {"1": None, "2": None, "3": None}

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
