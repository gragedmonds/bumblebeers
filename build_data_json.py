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
    """Yield (sub_code, sub_attrs) for each fill_lineup_index / goto_lineup_index
    that lives nested inside a lineup-update transaction's events array.
    """
    for sub in event_data.get("events") or []:
        code = sub.get("code")
        if code in ("fill_lineup_index", "goto_lineup_index"):
            yield code, sub.get("attributes") or {}


def _compute_runners_before(raw, player_id_map):
    """Walk the play stream and, for each transaction, return:

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

    Result keyed by (event_id, transaction_sequence_number). Known to be
    imperfect for older seasons where scorers were terse (CLAUDE.md
    "play-by-play is incomplete for historical seasons"). We never invent
    runners — only place ones the play stream already named.
    """
    out: dict[tuple[str, int], dict] = {}

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
            # Half-inning counter — bumped on every end_half. The viewer uses
            # the resulting id to decide when to clear runners between innings.
            half_inning_seq = 0

            def flush_pending():
                """Apply pending base_running events + play-result heuristic to bases.
                Also computes the `moves` and `after` snapshot for the most-recent
                transaction (last_tx_seq) and stitches them back into `out`."""
                nonlocal bases
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
                    half_inning_seq += 1
            # End of game: flush any trailing pending events (defensive).
            flush_pending()
    return out


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


def _detect_walks_and_strikeouts(raw, player_id_map):
    """Walk the play stream and synthesize at-bat rows for every Bumblebees
    plate appearance that ended in a walk or strikeout. These outcomes are
    NOT logged as `transaction` events in the raw stream — they only exist
    as sequences of standalone `pitch` events (4 balls → walk, 3 strikes →
    strikeout). build_excel.py only emits an AtBats row when a `ball_in_play`
    fires inside a transaction, so walks/Ks are systematically missing from
    the xlsx. This function recovers them.

    Tracks lineup state minimally so each synthetic AB carries the correct
    batter. Only Bumblebees ABs are emitted (matches the rest of the
    pipeline's "Bumblebees offense only" stance).
    """
    out: list[dict] = []
    if not raw:
        return out

    for t in raw.get("teams", []) or []:
        tm = t.get("team_meta") or {}
        owning_team_id = tm.get("id")
        season_year = tm.get("season_year")
        if not owning_team_id:
            continue

        for g in t.get("games", []) or []:
            entry = g.get("schedule_entry") or {}
            ev = entry.get("event") or {}
            eid = ev.get("id")
            pre = entry.get("pregame_data") or {}
            home_away = pre.get("home_away")
            opponent = pre.get("opponent_name")
            date_str = _local_date_from_event_start(ev.get("start"))

            # Bumblebees bat top of inning if AWAY, bottom if HOME.
            bmbl_offense = (home_away != "home")
            outs = 0
            balls = 0
            strikes = 0
            half_inning_idx = -1  # increments on each end_half

            lineup_slot: dict[str, dict[int, str]] = defaultdict(dict)
            lineup_idx: dict[str, int] = defaultdict(int)

            def emit(result: str, last_seq: int) -> None:
                nonlocal outs
                if not bmbl_offense:
                    return
                slots = lineup_slot.get(owning_team_id) or {}
                pid = None
                if slots:
                    size = max(slots.keys()) + 1
                    ix = lineup_idx.get(owning_team_id, 0) % size
                    pid = slots.get(ix)
                name = player_id_map.get(pid) if pid else None
                out.append({
                    "person_key": pk(name) if name else "",
                    "batter": name,
                    "season_year": season_year,
                    "date": date_str,
                    "opponent": opponent,
                    "result": result,
                    "play_type": None,
                    "defender_position": None,
                    "field_zone": "other",
                    "field_side": "other",
                    "runs_scored": 0,
                    "run_scoring": False,
                    "x": None,
                    "y": None,
                    "transaction_seq": int(last_seq) if last_seq is not None else 0,
                    "event_id": eid,
                    # runners_before/after/moves/half_inning_id get backfilled
                    # by _compute_runners_before's lookup keyed on
                    # (event_id, transaction_seq) — and if there's no match,
                    # the main() fallback fills with empties.
                    "half_inning_id": f"{eid}:{half_inning_idx}",
                })
                lineup_idx[owning_team_id] = lineup_idx.get(owning_team_id, 0) + 1
                if result == "strike_out":
                    outs += 1

            plays = sorted(
                g.get("plays") or [], key=lambda p: p.get("sequence_number", 0)
            )
            for p in plays:
                seq = p.get("sequence_number")
                try:
                    ed = json.loads(p["event_data"])
                except Exception:
                    continue
                code = ed.get("code")
                attrs = ed.get("attributes") or {}

                if code == "end_half":
                    half_inning_idx += 1
                    bmbl_offense = not bmbl_offense
                    outs = 0
                    balls = 0
                    strikes = 0
                    continue

                if code == "fill_lineup_index":
                    tid = attrs.get("teamId")
                    i = attrs.get("index")
                    pid = attrs.get("playerId")
                    if tid and pid and isinstance(i, int):
                        lineup_slot[tid][i] = pid
                    continue

                if code == "fill_lineup":
                    tid = attrs.get("teamId")
                    pid = attrs.get("playerId")
                    if tid and pid:
                        used = set(lineup_slot[tid].keys())
                        next_i = 0
                        while next_i in used:
                            next_i += 1
                        lineup_slot[tid][next_i] = pid
                    continue

                if code == "goto_lineup_index":
                    tid = attrs.get("teamId")
                    i = attrs.get("index")
                    if tid and isinstance(i, int):
                        lineup_idx[tid] = i
                    continue

                if code == "sub_players":
                    tid = attrs.get("teamId")
                    out_pid = attrs.get("outgoingPlayerId")
                    in_pid = attrs.get("incomingPlayerId")
                    if tid and out_pid and in_pid:
                        for ix, opid in list(lineup_slot[tid].items()):
                            if opid == out_pid:
                                lineup_slot[tid][ix] = in_pid
                    continue

                if code == "pitch":
                    r = attrs.get("result") or ""
                    if r in _PITCH_BALL:
                        balls += 1
                        if balls >= 4:
                            emit("walk", seq)
                            balls = 0
                            strikes = 0
                    elif r in _PITCH_STRIKE:
                        strikes += 1
                        if strikes >= 3:
                            emit("strike_out", seq)
                            balls = 0
                            strikes = 0
                    elif r in _PITCH_FOUL:
                        if strikes < 2:
                            strikes += 1
                    continue

                if code == "transaction":
                    subs = ed.get("events") or []
                    has_bip = any(s.get("code") == "ball_in_play" for s in subs)
                    if has_bip:
                        # AB ended on contact — advance lineup + reset counters.
                        if bmbl_offense:
                            lineup_idx[owning_team_id] = (
                                lineup_idx.get(owning_team_id, 0) + 1
                            )
                            for s in subs:
                                if s.get("code") == "ball_in_play":
                                    pr = (s.get("attributes") or {}).get("playResult", "")
                                    if "out" in pr or pr in (
                                        "fielders_choice",
                                        "sacrifice_fly",
                                        "infield_fly",
                                    ):
                                        outs += 1
                        balls = 0
                        strikes = 0
                    else:
                        # Lineup-update transaction — walk nested events.
                        for s in subs:
                            sc = s.get("code")
                            sa = s.get("attributes") or {}
                            if sc == "fill_lineup_index":
                                tid = sa.get("teamId")
                                i = sa.get("index")
                                pid = sa.get("playerId")
                                if tid and pid and isinstance(i, int):
                                    lineup_slot[tid][i] = pid
                            elif sc == "goto_lineup_index":
                                tid = sa.get("teamId")
                                i = sa.get("index")
                                if tid and isinstance(i, int):
                                    lineup_idx[tid] = i
                    continue
    return out


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

        # Recover walks + strikeouts from pitch sequences. GameChanger does
        # NOT emit a transaction for these outcomes — they exist only as
        # standalone `pitch` events (4 balls → walk, 3 strikes → K). This
        # builder synthesizes one AB row per detected walk/K with the right
        # batter (via lineup tracking), date, and opponent.
        synthetic = _detect_walks_and_strikeouts(raw, player_id_map)
        walk_n = sum(1 for s in synthetic if s["result"] == "walk")
        k_n = sum(1 for s in synthetic if s["result"] == "strike_out")
        print(
            f"pitch-sequence detector: +{walk_n} walks, +{k_n} strikeouts "
            f"({len(synthetic)} synthetic at-bats appended)"
        )
        at_bats.extend(synthetic)

        motion = _compute_runners_before(raw, player_id_map)
        with_runners = 0
        with_moves = 0
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
        print(
            f"motion: {with_runners}/{len(at_bats)} at-bats with runners on, "
            f"{with_moves} with explicit runner moves"
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
