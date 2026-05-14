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
SEASON_STATS_JSON = os.path.join(HERE, "gamechanger_season_stats.json")
OUT_DIR = os.path.join(HERE, "web", "public", "data")
OUT = os.path.join(OUT_DIR, "snapshot.json")

# Offense fields we lift from the authoritative season-stats endpoint and
# bake into snapshot.players[key].seasons[year].stats. These are the only
# source for strikeouts (SO), walks (BB), and hit-by-pitches (HBP) — the
# play-by-play stream does NOT record them per-AB; only ball-in-play
# outcomes get logged. HR totals here are also more accurate than the pbp
# count in older seasons (see CLAUDE.md "data quirks 3 — play-by-play is
# incomplete for historical seasons").
_SEASON_STAT_FIELDS = ["PA", "AB", "H", "1B", "2B", "3B", "HR", "TB",
                       "BB", "SO", "HBP", "SF", "FC", "ROE", "R", "RBI",
                       "SB", "CS", "AVG", "OB"]

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
    """Yield (sub_code, sub_attrs) for every lineup-state event nested
    inside a lineup-update transaction. Includes fill_lineup (mass fills
    without an explicit slot index) and sub_players because at game start
    the roster is often built via these alongside fill_lineup_index.
    """
    for sub in event_data.get("events") or []:
        code = sub.get("code")
        if code in (
            "fill_lineup_index",
            "fill_lineup",
            "goto_lineup_index",
            "sub_players",
            "clear_lineup_index",
            "clear_entire_lineup",
        ):
            yield code, sub.get("attributes") or {}


def _compute_runners_before(raw, player_id_map):
    """Walk the play stream and, for each at-bat (real or synthetic), return:

        {
          "before": {"1": name|None, "2": ..., "3": ...},
          "after":  {"1": name|None, "2": ..., "3": ...},
          "moves":  [{"name": str, "from": 0|1|2|3, "to": 1|2|3|4|"out"}, ...],
          "half_inning_id": "<eid>:<seq#>",
        }

    `before` / `after` snapshot occupancy. `moves` are the explicit runner
    transitions caused by THIS at-bat — including the batter's own move
    (from = 0 = batter's box). `half_inning_id` increments on every
    `end_half` so the viewer can detect inning changes and clear the bases.

    Also detects walks (4 balls) + strikeouts (3 strikes) from pitch
    sequences, since GameChanger never emits a transaction for either.
    Returned as (motion_by_seq, synthetic_abs) where synthetic_abs are
    AB rows ready to extend the main at_bats list. Walks update base
    state, so transactions FOLLOWING a walk get the correct
    runners_before.

    Result keyed by (event_id, transaction_sequence_number). Known to be
    imperfect for older seasons where scorers were terse (CLAUDE.md
    "play-by-play is incomplete for historical seasons"). We never invent
    runners — only place ones the play stream already named.
    """
    out: dict[tuple[str, int], dict] = {}
    synthetic_abs: list[dict] = []

    for t in raw.get("teams", []):
        tm = t.get("team_meta") or {}
        owning_team_id = tm.get("id")
        season_year_for_team = tm.get("season_year")
        for g in t.get("games") or []:
            entry = g.get("schedule_entry") or {}
            event_obj = entry.get("event") or {}
            eid = event_obj.get("id")
            pre = entry.get("pregame_data") or {}
            home_away = pre.get("home_away")
            opponent_name = pre.get("opponent_name")
            date_local = _local_date_from_event_start(event_obj.get("start"))
            # Bumblebees bat top of 1st when away, bottom of 1st when home.
            bmbl_offense = (home_away != "home")
            outs = 0
            balls = 0
            strikes = 0
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
            # Half-inning counter — bumped on every end_half. The viewer uses
            # the resulting id to decide when to clear runners between innings.
            half_inning_seq = 0

            def dedup_bases(b: dict[int, str | None]) -> dict[int, str | None]:
                """A runner can never legitimately appear on two bases at once.
                If a duplicate exists, keep the runner on the higher base — they
                advance forward, never backwards. This guards against scorer
                undo/override/redundant-event corruption upstream."""
                seen: dict[str, int] = {}
                for base in (1, 2, 3):
                    rid = b.get(base)
                    if rid is None:
                        continue
                    prev = seen.get(rid)
                    if prev is None or base > prev:
                        if prev is not None:
                            b[prev] = None
                        seen[rid] = base
                    else:
                        b[base] = None
                return b

            def flush_pending():
                """Apply pending base_running events + play-result heuristic to bases.
                Also computes the `moves` and `after` snapshot for the most-recent
                transaction (last_tx_seq) and stitches them back into `out`."""
                nonlocal bases, last_tx_seq, last_tx_result, last_tx_batter
                if last_tx_seq is None:
                    pending_brs.clear()
                    return
                explicit_runners: set[str] = set()
                # Track each runner's destination this play. Keyed by runner_id.
                # Values: 1|2|3 (new base), 4 (scored), "out".
                runner_dest: dict[str, int | str] = {}
                next_bases: dict[int, str | None] = {1: None, 2: None, 3: None}
                # 1) Process explicit base_running events from the play stream.
                # Each one explicitly moves a named runner to a new base / scored / out.
                for ev in pending_brs:
                    rid = ev.get("runnerId")
                    base = ev.get("base")
                    pt = (ev.get("playType") or "").lower()
                    if not rid:
                        continue
                    explicit_runners.add(rid)
                    if "out" in pt:
                        runner_dest[rid] = "out"
                        continue
                    if base == 4:
                        runner_dest[rid] = 4
                        continue
                    if base in (1, 2, 3) and next_bases[base] is None:
                        next_bases[base] = rid
                        runner_dest[rid] = base
                # 2) Untagged runners advance by the play-result default.
                advance_n = _RUNNER_ADVANCE_FOR.get(last_tx_result or "", 0)
                for b in (1, 2, 3):
                    rid = bases.get(b)
                    if rid is None or rid in explicit_runners:
                        continue
                    new_b = b + advance_n
                    if 1 <= new_b <= 3 and next_bases[new_b] is None:
                        next_bases[new_b] = rid
                        if new_b != b:
                            runner_dest[rid] = new_b
                    elif new_b >= 4:
                        runner_dest[rid] = 4
                # 3) Place the batter from the prior transaction.
                if last_tx_batter and last_tx_result:
                    target = _BATTER_LANDS_AT.get(last_tx_result)
                    if target in (1, 2, 3) and next_bases[target] is None:
                        next_bases[target] = last_tx_batter
                        runner_dest[last_tx_batter] = target
                    elif target == 4:  # home run
                        runner_dest[last_tx_batter] = 4
                    # If the batter is out (no entry in _BATTER_LANDS_AT), we don't
                    # claim them — the result string carries that information.

                # Build the structured moves[] list. For each runner_dest entry,
                # figure out their `from` base (look them up in `bases`, else 0
                # if they're the batter who just stepped in).
                moves: list[dict] = []
                for rid, dest in runner_dest.items():
                    from_b: int = 0
                    for b in (1, 2, 3):
                        if bases.get(b) == rid:
                            from_b = b
                            break
                    moves.append({
                        "name": player_id_map.get(rid, "Unknown"),
                        "from": from_b,
                        "to": dest,
                    })

                # Dedup BEFORE snapshotting `after` so the saved state can't
                # show the same runner on two bases.
                next_bases = dedup_bases(next_bases)
                # Stitch moves + after-snapshot back into the result for
                # the transaction we just finished resolving.
                prior = out.get((eid, last_tx_seq))
                if prior is not None:
                    prior["moves"] = moves
                    prior["after"] = {
                        "1": player_id_map.get(next_bases[1]) if next_bases[1] else None,
                        "2": player_id_map.get(next_bases[2]) if next_bases[2] else None,
                        "3": player_id_map.get(next_bases[3]) if next_bases[3] else None,
                    }

                bases = next_bases
                pending_brs.clear()
                # Idempotency: clear last_tx_* so a subsequent flush_pending
                # call (e.g. from fire_walk/fire_strikeout before the next
                # real transaction sets these fresh) doesn't re-place the
                # batter on a base that already reflects them.
                last_tx_seq = None
                last_tx_result = None
                last_tx_batter = None

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

            def batting_tid() -> str | None:
                """Team currently batting: BMBL when bmbl_offense, else the
                other team_id seen in lineup_slot. The `current_offense_team`
                variable can be stale (it just reflects the last lineup
                operation seen, including pre-game opponent setup)."""
                if bmbl_offense:
                    return owning_team_id
                for tid in lineup_slot:
                    if tid != owning_team_id:
                        return tid
                return None

            def pick_batter(bat_tid: str | None) -> str | None:
                """Look up the current batter, skipping over any slot whose
                player is currently on a base (real-life lineup passes over
                runners on base). Also advances lineup_idx past the skipped
                slots so subsequent calls don't repeat the same batter."""
                if not bat_tid or bat_tid not in lineup_slot:
                    return None
                slots = lineup_slot[bat_tid]
                if not slots:
                    return None
                size = max(len(slots), 1)
                on_base = {rid for rid in bases.values() if rid}
                start_ix = lineup_idx.get(bat_tid, 0)
                for offset in range(size):
                    ix = (start_ix + offset) % size
                    pid = slots.get(ix)
                    if pid and pid not in on_base:
                        lineup_idx[bat_tid] = ix
                        return pid
                # Fallback: lineup entirely on base (impossible but defensive).
                return slots.get(start_ix % size)

            def fire_walk(pitch_seq: int) -> None:
                """A 4th ball just landed. Place batter on 1B, advance forced
                runners. Emit a synthetic AB if BMBL is on offense, plus a
                motion entry so subsequent transactions see correct bases.
                """
                nonlocal bases
                bat_tid = batting_tid()
                batter_id = pick_batter(bat_tid)
                # Force-advance: walk fills bases in order. 1B fills with
                # batter; runner on 1B forced to 2B if 1B was occupied; ditto
                # 2B→3B, 3B→home.
                flush_pending()  # close any prior transaction's motion
                before = dict(bases)
                next_bases: dict[int, str | None] = {1: None, 2: None, 3: None}
                moves: list[dict] = []
                runner_at_3 = bases.get(3)
                runner_at_2 = bases.get(2)
                runner_at_1 = bases.get(1)
                forced_3 = runner_at_3 is not None and runner_at_2 is not None and runner_at_1 is not None
                forced_2 = runner_at_2 is not None and runner_at_1 is not None
                forced_1 = runner_at_1 is not None
                # 3B: scores if forced; else stays on 3B
                if runner_at_3:
                    if forced_3:
                        moves.append({"name": player_id_map.get(runner_at_3, "Unknown"), "from": 3, "to": 4})
                    else:
                        next_bases[3] = runner_at_3
                # 2B: → 3B if forced; else stays
                if runner_at_2:
                    if forced_2:
                        next_bases[3] = runner_at_2
                        moves.append({"name": player_id_map.get(runner_at_2, "Unknown"), "from": 2, "to": 3})
                    else:
                        next_bases[2] = runner_at_2
                # 1B: → 2B if forced; else stays
                if runner_at_1:
                    if forced_1:
                        next_bases[2] = runner_at_1
                        moves.append({"name": player_id_map.get(runner_at_1, "Unknown"), "from": 1, "to": 2})
                    else:
                        next_bases[1] = runner_at_1
                # Batter to 1B
                if batter_id:
                    next_bases[1] = batter_id
                    moves.append({"name": player_id_map.get(batter_id, "Unknown"), "from": 0, "to": 1})
                bases = dedup_bases(next_bases)
                after = dict(bases)
                if bmbl_offense:
                    motion_entry = {
                        "before": {str(b): player_id_map.get(before[b]) if before[b] else None for b in (1, 2, 3)},
                        "after": {str(b): player_id_map.get(after[b]) if after[b] else None for b in (1, 2, 3)},
                        "moves": moves,
                        "half_inning_id": f"{eid}:{half_inning_seq}",
                    }
                    out[(eid, pitch_seq)] = motion_entry
                    runs_on_walk = sum(1 for m in moves if m["to"] == 4)
                    synthetic_abs.append({
                        "person_key": pk(player_id_map.get(batter_id)) if batter_id else "",
                        "batter": player_id_map.get(batter_id) if batter_id else None,
                        "season_year": season_year_for_team,
                        "date": date_local,
                        "opponent": opponent_name,
                        "result": "walk",
                        "play_type": None,
                        "defender_position": None,
                        "field_zone": "other",
                        "field_side": "other",
                        "runs_scored": runs_on_walk,
                        "run_scoring": runs_on_walk > 0,
                        "x": None,
                        "y": None,
                        "transaction_seq": int(pitch_seq),
                        "event_id": eid,
                    })
                if bat_tid:
                    lineup_idx[bat_tid] = lineup_idx.get(bat_tid, 0) + 1

            def fire_strikeout(pitch_seq: int) -> None:
                """3 strikes. No base change. Emit synthetic K AB if BMBL offense."""
                nonlocal outs
                flush_pending()
                bat_tid = batting_tid()
                batter_id = pick_batter(bat_tid)
                if bmbl_offense:
                    out[(eid, pitch_seq)] = {
                        "before": {str(b): player_id_map.get(bases[b]) if bases[b] else None for b in (1, 2, 3)},
                        "after": {str(b): player_id_map.get(bases[b]) if bases[b] else None for b in (1, 2, 3)},
                        "moves": [],
                        "half_inning_id": f"{eid}:{half_inning_seq}",
                    }
                    synthetic_abs.append({
                        "person_key": pk(player_id_map.get(batter_id)) if batter_id else "",
                        "batter": player_id_map.get(batter_id) if batter_id else None,
                        "season_year": season_year_for_team,
                        "date": date_local,
                        "opponent": opponent_name,
                        "result": "strike_out",
                        "play_type": None,
                        "defender_position": None,
                        "field_zone": "other",
                        "field_side": "other",
                        "runs_scored": 0,
                        "run_scoring": False,
                        "x": None,
                        "y": None,
                        "transaction_seq": int(pitch_seq),
                        "event_id": eid,
                    })
                if bat_tid:
                    lineup_idx[bat_tid] = lineup_idx.get(bat_tid, 0) + 1
                outs += 1

            def flip_half():
                """End of half-inning: flip offense, reset outs + count, clear bases."""
                nonlocal bmbl_offense, outs, balls, strikes, bases, half_inning_seq
                nonlocal last_tx_seq, last_tx_result, last_tx_batter
                # Close any trailing motion for the prior transaction.
                flush_pending()
                bmbl_offense = not bmbl_offense
                outs = 0
                balls = 0
                strikes = 0
                bases = {1: None, 2: None, 3: None}
                last_tx_seq = None
                last_tx_result = None
                last_tx_batter = None
                half_inning_seq += 1

            for seq, code, ed in decoded:
                attrs = ed.get("attributes") or {}
                # 3-out fallback (mirror build_excel.GameState): if we've
                # accumulated 3 outs and the next event isn't an end_half,
                # flip the half-inning ourselves.
                if outs >= 3 and code != "end_half":
                    flip_half()
                if code == "fill_lineup_index":
                    tid = apply_fill(attrs)
                    if tid:
                        current_offense_team = tid
                elif code == "fill_lineup":
                    tid = attrs.get("teamId")
                    pid = attrs.get("playerId")
                    if tid and pid:
                        used = set(lineup_slot[tid].keys())
                        next_i = 0
                        while next_i in used:
                            next_i += 1
                        lineup_slot[tid][next_i] = pid
                        current_offense_team = tid
                elif code == "goto_lineup_index":
                    tid = apply_goto(attrs)
                    if tid:
                        current_offense_team = tid
                elif code == "sub_players":
                    tid = attrs.get("teamId")
                    out_pid = attrs.get("outgoingPlayerId")
                    in_pid = attrs.get("incomingPlayerId")
                    if tid and out_pid and in_pid:
                        for ix, opid in list(lineup_slot[tid].items()):
                            if opid == out_pid:
                                lineup_slot[tid][ix] = in_pid
                elif code == "clear_lineup_index":
                    tid = attrs.get("teamId")
                    i = attrs.get("index")
                    if tid and isinstance(i, int) and i in lineup_slot[tid]:
                        del lineup_slot[tid][i]
                elif code == "clear_entire_lineup":
                    tid = attrs.get("teamId")
                    if tid:
                        lineup_slot[tid].clear()
                elif code == "pitch":
                    r = attrs.get("result") or ""
                    if r in _PITCH_BALL:
                        balls += 1
                        if balls >= 4:
                            fire_walk(seq)
                            balls = 0
                            strikes = 0
                    elif r in _PITCH_STRIKE:
                        strikes += 1
                        if strikes >= 3:
                            fire_strikeout(seq)
                            balls = 0
                            strikes = 0
                    elif r in _PITCH_FOUL:
                        if strikes < 2:
                            strikes += 1
                elif code == "transaction":
                    play_result = _extract_play_result(ed)
                    if play_result:
                        # REAL at-bat. Finalize any prior runner motion, then snapshot.
                        flush_pending()
                        # Identify the batter via the offense team's lineup
                        # pointer, skipping past any slot whose player is
                        # currently on a base. The pointer is advanced
                        # explicitly per AB below.
                        bat_tid = batting_tid()
                        batter_id = pick_batter(bat_tid)
                        out[(eid, seq)] = {
                            "before": {
                                "1": player_id_map.get(bases[1]) if bases[1] else None,
                                "2": player_id_map.get(bases[2]) if bases[2] else None,
                                "3": player_id_map.get(bases[3]) if bases[3] else None,
                            },
                            # `moves` and `after` get filled in by the next
                            # flush_pending() call (at the next transaction or
                            # end_half). Initialize them so consumers can rely
                            # on the shape even if scoring data is missing.
                            "moves": [],
                            "after": {"1": None, "2": None, "3": None},
                            "half_inning_id": f"{eid}:{half_inning_seq}",
                            # Motion-walker's identified batter. More accurate
                            # than build_excel's because we advance for synthetic
                            # walks/Ks too. Used to override the XLSX batter
                            # when they disagree (XLSX's pointer drifts after
                            # walks/Ks).
                            "batter_name": player_id_map.get(batter_id) if batter_id else None,
                        }
                        last_tx_seq = seq
                        last_tx_result = play_result
                        last_tx_batter = batter_id
                        if bat_tid:
                            lineup_idx[bat_tid] = (
                                lineup_idx.get(bat_tid, 0) + 1
                            )
                        # Real AB resets the count
                        balls = 0
                        strikes = 0
                        # Outs tally for 3-out fallback
                        if play_result in {"batter_out", "batter_out_advance_runners",
                                           "sacrifice_fly", "infield_fly", "strike_out",
                                           "dropped_third_strike_batter_out", "other_out",
                                           "fielders_choice"}:
                            outs += 1
                    else:
                        # LINEUP-UPDATE transaction: walk its nested events and
                        # update lineup state, but DO NOT snapshot or flush.
                        for sub_code, sub_attrs in _walk_lineup_subs(ed):
                            if sub_code == "fill_lineup_index":
                                tid = apply_fill(sub_attrs)
                                if tid:
                                    current_offense_team = tid
                            elif sub_code == "fill_lineup":
                                tid = sub_attrs.get("teamId")
                                pid = sub_attrs.get("playerId")
                                if tid and pid:
                                    used = set(lineup_slot[tid].keys())
                                    next_i = 0
                                    while next_i in used:
                                        next_i += 1
                                    lineup_slot[tid][next_i] = pid
                                    current_offense_team = tid
                            elif sub_code == "goto_lineup_index":
                                tid = apply_goto(sub_attrs)
                                if tid:
                                    current_offense_team = tid
                            elif sub_code == "sub_players":
                                tid = sub_attrs.get("teamId")
                                out_pid = sub_attrs.get("outgoingPlayerId")
                                in_pid = sub_attrs.get("incomingPlayerId")
                                if tid and out_pid and in_pid:
                                    for ix, opid in list(lineup_slot[tid].items()):
                                        if opid == out_pid:
                                            lineup_slot[tid][ix] = in_pid
                            elif sub_code == "clear_lineup_index":
                                tid = sub_attrs.get("teamId")
                                i = sub_attrs.get("index")
                                if tid and isinstance(i, int) and i in lineup_slot[tid]:
                                    del lineup_slot[tid][i]
                            elif sub_code == "clear_entire_lineup":
                                tid = sub_attrs.get("teamId")
                                if tid:
                                    lineup_slot[tid].clear()
                elif code == "base_running":
                    if last_tx_seq is not None:
                        pending_brs.append(attrs)
                    # Top-level scoring base_running can also bump outs
                    if (attrs.get("playType") or "").lower() in {"out_on_last_play",
                                                                  "caught_stealing",
                                                                  "picked_off",
                                                                  "out_at_base", "out"}:
                        outs += 1
                elif code == "end_half":
                    flip_half()
            # End of game: flush any trailing pending events (defensive).
            flush_pending()
    return out, synthetic_abs


# Pitch results that count as balls / strikes / fouls for AB-outcome detection.
_PITCH_BALL = {"ball", "intentional_ball", "illegal_pitch"}
_PITCH_STRIKE = {"strike_looking", "strike_swinging", "foul_tip"}
_PITCH_FOUL = {"foul"}


def _local_date_from_event_start(start) -> str:
    """ev.start can be a dict {datetime: ISO} or a bare string. Returns
    YYYY-MM-DD in America/Toronto so doubleheaders that cross midnight UTC
    still bucket together."""
    if isinstance(start, dict):
        s = start.get("datetime") or start.get("date") or ""
    else:
        s = str(start or "")
    if not s:
        return ""
    try:
        import datetime
        try:
            from zoneinfo import ZoneInfo
        except ImportError:
            return s[:10]
        dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.astimezone(ZoneInfo("America/Toronto")).strftime("%Y-%m-%d")
    except Exception:
        return s[:10]


def _season_year_from_meta(meta: dict) -> int | None:
    """Pull a season year out of a team_meta block. season_name is shaped
    like '2025 Summer Bumblebeers' — first integer wins."""
    for key in ("season_name", "season_year", "name"):
        v = meta.get(key)
        if isinstance(v, int):
            return v
        if isinstance(v, str):
            for tok in v.split():
                if tok.isdigit() and len(tok) == 4:
                    return int(tok)
    return None


def load_season_stats_by_player_season() -> dict[tuple[str, int], dict]:
    """Index gamechanger_season_stats.json by (person_key, season_year) →
    offense stats dict. Pulls only the fields in _SEASON_STAT_FIELDS to
    keep the snapshot lean."""
    if not os.path.exists(SEASON_STATS_JSON):
        print(f"WARN: {SEASON_STATS_JSON} not found; season stats won't enrich players")
        return {}
    with open(SEASON_STATS_JSON, "r", encoding="utf-8") as f:
        ss = json.load(f)
    out: dict[tuple[str, int], dict] = {}
    for t in ss.get("teams") or []:
        meta = t.get("team_meta") or {}
        season_year = _season_year_from_meta(meta)
        if season_year is None:
            continue
        # Build a player_id → first_name lookup from the team's players array.
        name_for: dict[str, str] = {}
        for pp in t.get("players") or []:
            pid = pp.get("id") or pp.get("person_id")
            nm = pp.get("first_name") or pp.get("display_name") or ""
            if pid and nm:
                name_for[pid] = nm
        sd = (t.get("season_stats") or {}).get("stats_data") or {}
        players = sd.get("players") or {}
        for pid, pdata in players.items():
            off = ((pdata or {}).get("stats") or {}).get("offense") or {}
            if not off:
                continue
            name = name_for.get(pid) or ""
            if not name:
                continue
            key = pk(name)
            slim = {f: off[f] for f in _SEASON_STAT_FIELDS if f in off}
            # If the same (key, season) appears in two team objects (e.g. an
            # earlier draft + a later one), prefer the one with more PA.
            existing = out.get((key, season_year))
            if existing and (existing.get("PA") or 0) >= (slim.get("PA") or 0):
                continue
            out[(key, season_year)] = slim
    return out


def enrich_seasons_with_authoritative_stats(
    by_player: dict, season_stats: dict[tuple[str, int], dict]
) -> int:
    """Merge season-stats offense numbers into snapshot.players[key].seasons[N].stats.
    Returns the number of (player, season) entries enriched."""
    if not season_stats:
        return 0
    n = 0
    for key, p in by_player.items():
        for s in p.get("seasons") or []:
            year = s.get("season_year")
            entry = season_stats.get((key, year))
            if entry:
                s["stats"] = entry
                n += 1
    return n


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

    # Enrich seasons with authoritative offense totals from the season-stats
    # endpoint. THIS is the only source of strikeouts / walks / HBPs since the
    # play-by-play doesn't log them per-AB. Also corrects HR undercount in
    # older seasons (the pbp stream lost a chunk of older home runs).
    season_stats = load_season_stats_by_player_season()
    enriched = enrich_seasons_with_authoritative_stats(by_player, season_stats)
    print(f"season-stats: enriched {enriched} player-season entries with offense totals")

    # Phase 3 / 3.5 enrichment: walk the raw play stream once to compute
    # per-transaction base state (before + after), the explicit runner moves
    # that happened during the at-bat, and a half-inning id the viewer uses
    # to decide when to clear runners between innings.
    if os.path.exists(RAW_JSON):
        with open(RAW_JSON, "r", encoding="utf-8") as f:
            raw = json.load(f)
        player_id_map = _build_player_id_map(raw)

        # Single pass over the raw stream produces BOTH the per-transaction
        # motion dict (runners_before/after + moves) AND synthetic AB rows
        # for walks (4 balls) + strikeouts (3 strikes) — GameChanger never
        # emits a transaction for those outcomes. Walks update base state so
        # subsequent transactions see the correct runners_before.
        motion, synthetic = _compute_runners_before(raw, player_id_map)
        walk_n = sum(1 for s in synthetic if s["result"] == "walk")
        k_n = sum(1 for s in synthetic if s["result"] == "strike_out")
        print(
            f"pitch-sequence detector: +{walk_n} walks, +{k_n} strikeouts "
            f"({len(synthetic)} synthetic at-bats appended)"
        )
        at_bats.extend(synthetic)
        with_runners = 0
        with_moves = 0
        runs_recomputed = 0
        batter_overridden = 0
        for ab in at_bats:
            key = (ab.get("event_id"), ab.get("transaction_seq"))
            m = motion.get(key)
            if m is None:
                ab["runners_before"] = {"1": None, "2": None, "3": None}
                ab["runners_after"] = {"1": None, "2": None, "3": None}
                ab["runner_moves"] = []
                ab["half_inning_id"] = None
            else:
                ab["runners_before"] = m["before"]
                ab["runners_after"] = m.get("after", {"1": None, "2": None, "3": None})
                ab["runner_moves"] = m.get("moves", [])
                ab["half_inning_id"] = m.get("half_inning_id")
                if any(m["before"].values()):
                    with_runners += 1
                if ab["runner_moves"]:
                    with_moves += 1
                # Recompute runs_scored from `moves`: count every runner that
                # crossed home (to == 4). build_at_bats's run-counter only
                # counted EXPLICIT top-level base_running base=4 events, so it
                # undercounted plays where the scorer didn't tag every
                # scoring runner. The motion walker tracks both explicit and
                # heuristic advancement, so it's strictly more complete.
                moves_runs = sum(1 for mv in ab["runner_moves"] if mv.get("to") == 4)
                if moves_runs != (ab.get("runs_scored") or 0):
                    runs_recomputed += 1
                ab["runs_scored"] = moves_runs
                ab["run_scoring"] = moves_runs > 0
                # Override XLSX-derived batter when motion's lineup tracking
                # disagrees. build_excel only advances lineup_idx on real
                # transactions, so its batter drifts wrong after walks/Ks.
                # The motion walker tracks both, so its batter is canonical.
                motion_batter = m.get("batter_name")
                if motion_batter and motion_batter != ab.get("batter"):
                    ab["batter"] = motion_batter
                    ab["person_key"] = pk(motion_batter)
                    batter_overridden += 1
        print(
            f"motion: {with_runners}/{len(at_bats)} at-bats with runners on, "
            f"{with_moves} with explicit runner moves; "
            f"recomputed runs_scored on {runs_recomputed} at-bats; "
            f"overrode batter on {batter_overridden} at-bats"
        )
    else:
        for ab in at_bats:
            ab["runners_before"] = {"1": None, "2": None, "3": None}
            ab["runners_after"] = {"1": None, "2": None, "3": None}
            ab["runner_moves"] = []
            ab["half_inning_id"] = None

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
