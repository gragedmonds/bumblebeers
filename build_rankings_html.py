"""
Generate bumblebeers_rankings.html from viewer_template.html.

Reads:
  - _pergame.json (produced by build_rankings.py) for season/career/per-game data
  - bumblebeers_gamechanger.xlsx AtBats sheet for the spray-chart at-bats with coords

Embeds it all into the template's __DATA__ placeholder and writes the final HTML.
"""
from __future__ import annotations
import json
import os
from collections import defaultdict
import pandas as pd
import math

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "_pergame.json")
ATBATS_XLSX = os.path.join(HERE, "bumblebeers_gamechanger.xlsx")
RAW_JSON = os.path.join(HERE, "gamechanger_bumblebeers_raw.json")
TEMPLATE = os.path.join(HERE, "viewer_template.html")
OUT  = os.path.join(HERE, "bumblebeers_rankings.html")

# Manual aliases confirmed by the user
NAME_ALIASES = {
    "alex tosun": "alex",
    "brandon porco": "porco",
    "z.terence": "terence",
}

def pk(name):
    if name is None or (isinstance(name, float) and math.isnan(name)):
        return ""
    s = str(name).strip().lower()
    return NAME_ALIASES.get(s, s)


def load_pergame_bundle():
    with open(DATA, "r", encoding="utf-8") as f:
        return json.load(f)


def build_players_map(bundle):
    by_player = defaultdict(lambda: {"display_name": "", "seasons": [], "games": []})
    for s in bundle["season_summaries"]:
        if not s.get("PA"):
            continue
        key = pk(s["display_name"])
        by_player[key]["display_name"] = s["display_name"]
        by_player[key]["seasons"].append({
            "season_year": s["season_year"],
            "PA": s["PA"],
            "wOBA": round(float(s["wOBA"]), 3) if s.get("wOBA") is not None else None,
            "BMBL_plus": round(float(s["BMBL_plus"]), 1) if s.get("BMBL_plus") is not None else None,
            "qualified": bool(s.get("qualified", False)),
        })
    for g in bundle["per_game"]:
        key = pk(g.get("batter") or "")
        if not key:
            continue
        date = g.get("date_only") or (g.get("date_local") or "")[:10]
        by_player[key]["display_name"] = by_player[key]["display_name"] or g.get("batter") or ""
        by_player[key]["games"].append({
            "date": date,
            "season_year": int(g["season_year"]),
            "opponent": g.get("opponent"),
            "PA": int(g.get("PA") or 0),
            "AB": int(g.get("AB") or 0),
            "H":  int(g.get("H")  or 0),
            "HR": int(g.get("HR") or 0),
            "wOBA_game": round(float(g["wOBA_shrunk_game"]), 3) if g.get("wOBA_shrunk_game") not in (None, "") else None,
        })
    return by_player


def _none_if_nan(x):
    try:
        if x is None: return None
        f = float(x)
        if math.isnan(f): return None
        return round(f, 2)
    except (TypeError, ValueError):
        return None


def _safe_str(x):
    """Convert pandas value to a clean Python string or None — no NaN leaks."""
    if x is None: return None
    if isinstance(x, float) and math.isnan(x): return None
    s = str(x).strip()
    return s if s else None


_OUTFIELD = {"LF", "CF", "RF", "SF"}
_INFIELD  = {"1B", "2B", "3B", "SS", "P", "C"}

def build_at_bats():
    if not os.path.exists(ATBATS_XLSX):
        print(f"WARN: {ATBATS_XLSX} not found; diamond tab will be empty")
        return []
    df = pd.read_excel(ATBATS_XLSX, sheet_name="AtBats")
    # Previously this dropped rows with NaN defender_x/y, which removed
    # ~124 home runs (the ball leaves the field, so no fielder coords) and
    # a handful of other_outs. Those rows ARE real at-bats — keep them.
    # x/y get coerced to None downstream so the spray chart still skips
    # them, while every other code path sees the full at-bat log.
    # date_local is stored as UTC; convert to America/Toronto so a doubleheader
    # that runs across midnight UTC still buckets to one local date.
    utc = pd.to_datetime(df["date_local"], utc=True)
    df["date_only"] = utc.dt.tz_convert("America/Toronto").dt.date.astype(str)

    # Compute runs scored per at-bat by walking the raw play stream. Scorers
    # tag runner-scoring as TOP-LEVEL base_running events (playType
    # "advanced_on_last_play", base=4) that follow the transaction. Inside-
    # transaction base_runnings are less common. We attribute every scoring
    # base_running to the most recent transaction in the same half-inning.
    runs_per_ab = defaultdict(int)
    if os.path.exists(RAW_JSON):
        with open(RAW_JSON, "r", encoding="utf-8") as f:
            raw = json.load(f)
        for t in raw["teams"]:
            for g in t.get("games", []):
                eid = (g.get("schedule_entry") or {}).get("event", {}).get("id")
                plays = sorted(g.get("plays") or [], key=lambda p: p.get("sequence_number", 0))
                last_tx_seq = None
                for p in plays:
                    try:
                        ed = json.loads(p["event_data"])
                    except Exception:
                        continue
                    code = ed.get("code")
                    attrs = ed.get("attributes") or {}
                    if code == "transaction":
                        last_tx_seq = int(p.get("sequence_number") or 0)
                        # Also catch any inside-transaction scoring
                        for sub in ed.get("events", []) or []:
                            sa = sub.get("attributes") or {}
                            if sub.get("code") == "base_running" and sa.get("base") == 4:
                                pt = (sa.get("playType") or "").lower()
                                if "out" not in pt:
                                    runs_per_ab[(eid, last_tx_seq)] += 1
                    elif code == "base_running":
                        if attrs.get("base") == 4 and last_tx_seq is not None:
                            pt = (attrs.get("playType") or "").lower()
                            if "out" not in pt:
                                runs_per_ab[(eid, last_tx_seq)] += 1
                    elif code == "end_half":
                        last_tx_seq = None

    out = []
    for _, r in df.iterrows():
        result = _safe_str(r.get("result"))
        pos = _safe_str(r.get("defender_position")) or ""
        eid = _safe_str(r.get("event_id"))
        seq = int(r.get("transaction_seq") or 0)
        scoring_runners = runs_per_ab.get((eid, seq), 0)
        if result == "home_run":
            scoring_runners += 1  # the batter himself
        # field zone
        if pos in _OUTFIELD:
            zone = "outfield"
        elif pos in _INFIELD:
            zone = "infield"
        else:
            zone = "other"
        # left / right / middle quadrant — based on x relative to home (160) and pull side
        x = _none_if_nan(r["defender_x"])
        if x is None:
            side = "other"
        elif x < 120:
            side = "left"
        elif x > 200:
            side = "right"
        else:
            side = "middle"
        out.append({
            "person_key": pk(r.get("batter")),
            "batter": _safe_str(r.get("batter")),
            "season_year": int(r["season_year"]),
            "date": _safe_str(r["date_only"]),
            "opponent": _safe_str(r.get("opponent")),
            "result": result,
            "play_type": _safe_str(r.get("play_type")),
            "defender_position": pos or None,
            "field_zone": zone,
            "field_side": side,
            "runs_scored": scoring_runners,
            "run_scoring": scoring_runners > 0,
            "x": x,
            "y": _none_if_nan(r["defender_y"]),
            "transaction_seq": seq,
            "event_id": eid,
        })
    return out


_HIT_RESULTS = {"single","double","triple","home_run"}
_OUT_RESULTS_PY = {"batter_out","batter_out_advance_runners","infield_fly","other_out","fielders_choice","dropped_third_strike_batter_out","strike_out","sacrifice_fly"}
_AB_RESULTS = _HIT_RESULTS | {"batter_out","batter_out_advance_runners","infield_fly","other_out","fielders_choice","dropped_third_strike_batter_out","strike_out"}

def _stat_line(p):
    line = f"{p['H']}-for-{p['AB']}"
    extras = []
    if p["HR"] > 0: extras.append(f"{p['HR']} HR")
    if p["3B"] > 0: extras.append(f"{p['3B']} 3B")
    if p["2B"] > 0: extras.append(f"{p['2B']} 2B")
    if extras:
        line += f" ({', '.join(extras)})"
    if p["runs_scored"] > 0:
        line += f", {p['runs_scored']} run" + ("s" if p["runs_scored"] != 1 else "")
    return line


def _justification(mvp, runner_up, third):
    """Return a 1–3 sentence justification for the MVP pick."""
    mvp_line = _stat_line(mvp)
    if runner_up is None:
        return f"{mvp['display_name']} ({mvp_line}) — only qualified hitter for the night."
    margin = mvp["score"] - runner_up["score"]
    margin_pct = margin / mvp["score"] if mvp["score"] > 0 else 1.0
    ru_line = _stat_line(runner_up)
    if margin_pct >= 0.40:
        return f"{mvp['display_name']} ({mvp_line}) — clear-cut night."
    diffs = []
    if mvp["HR"] > runner_up["HR"]:
        diffs.append(f"the {mvp['HR']}-HR edge")
    elif mvp["XBH"] > runner_up["XBH"]:
        diffs.append(f"more extra-base hits ({mvp['XBH']} vs {runner_up['XBH']})")
    if mvp["TB"] > runner_up["TB"]:
        diffs.append(f"more total bases ({mvp['TB']} vs {runner_up['TB']})")
    if mvp["runs_scored"] > runner_up["runs_scored"]:
        diffs.append(f"more runs created ({mvp['runs_scored']} vs {runner_up['runs_scored']})")
    if mvp["H"] > runner_up["H"]:
        diffs.append(f"more hits ({mvp['H']} vs {runner_up['H']})")
    elif mvp["H"] == runner_up["H"] and mvp["outs"] < runner_up["outs"]:
        diffs.append(f"fewer outs ({mvp['outs']} vs {runner_up['outs']})")
    diff_text = "; ".join(diffs[:2]) if diffs else "edge in MVP score"
    if margin_pct < 0.10:
        opener = f"Tight race — {mvp['display_name']} ({mvp_line}) over {runner_up['display_name']} ({ru_line})"
    else:
        opener = f"{mvp['display_name']} ({mvp_line}) edged {runner_up['display_name']} ({ru_line})"
    return opener + f" on {diff_text}."


def build_mvp_nights(at_bats):
    """Group at-bats by date → per-player line → pick MVP and runner-up + justify."""
    from collections import defaultdict
    nights = defaultdict(lambda: {
        "opponents": set(),
        "players": defaultdict(lambda: {
            "PA":0, "AB":0, "H":0, "1B":0, "2B":0, "3B":0, "HR":0, "XBH":0, "TB":0,
            "SF":0, "FC":0, "ROE":0, "outs":0, "runs_scored":0, "display_name": "",
        }),
    })
    for ab in at_bats:
        date = ab.get("date")
        if not date:
            continue
        nights[date]["opponents"].add(ab.get("opponent") or "?")
        pk_ = ab.get("person_key") or ""
        if not pk_:
            continue
        p = nights[date]["players"][pk_]
        p["display_name"] = ab.get("batter") or pk_
        result = ab.get("result") or ""
        p["PA"] += 1
        if result in _AB_RESULTS:
            p["AB"] += 1
        if result in _HIT_RESULTS:
            p["H"] += 1
            if result == "single":     p["1B"] += 1; p["TB"] += 1
            elif result == "double":   p["2B"] += 1; p["TB"] += 2; p["XBH"] += 1
            elif result == "triple":   p["3B"] += 1; p["TB"] += 3; p["XBH"] += 1
            elif result == "home_run": p["HR"] += 1; p["TB"] += 4; p["XBH"] += 1
        elif result == "sacrifice_fly":
            p["SF"] += 1; p["outs"] += 1
        elif result == "fielders_choice":
            p["FC"] += 1; p["outs"] += 1
        elif result == "error":
            p["ROE"] += 1
        elif "out" in result:
            p["outs"] += 1
        p["runs_scored"] += int(ab.get("runs_scored") or 0)

    out = []
    for date in sorted(nights.keys()):
        info = nights[date]
        scored = []
        for pkey, p in info["players"].items():
            if p["PA"] < 2:  # eligibility: at least 2 PAs that night
                continue
            score = (
                p["TB"] * 1.5 +
                p["runs_scored"] * 1.2 +
                p["HR"] * 1.5 +
                p["XBH"] * 0.8 +
                p["SF"] * 0.5 +
                -p["outs"] * 0.4
            )
            scored.append({
                "person_key": pkey,
                "display_name": p["display_name"],
                "score": round(score, 2),
                "PA": p["PA"], "AB": p["AB"], "H": p["H"],
                "1B": p["1B"], "2B": p["2B"], "3B": p["3B"], "HR": p["HR"],
                "TB": p["TB"], "XBH": p["XBH"], "SF": p["SF"], "ROE": p["ROE"],
                "outs": p["outs"], "runs_scored": p["runs_scored"],
            })
        if not scored:
            continue
        scored.sort(key=lambda x: (-x["score"], -x["TB"], -x["H"]))
        mvp = scored[0]
        runner_up = scored[1] if len(scored) > 1 else None
        third = scored[2] if len(scored) > 2 else None
        season_year = int(date.split("-")[0]) if date else None
        out.append({
            "date": date,
            "season_year": season_year,
            "opponents": sorted(o for o in info["opponents"] if o),
            "mvp": mvp,
            "runner_up": runner_up,
            "top": scored[:5],
            "justification": _justification(mvp, runner_up, third),
        })
    # Newest first
    out.sort(key=lambda x: x["date"], reverse=True)
    return out


ANIMATE_AT_BAT_TAIL = r"""function animateAtBat(ab) {
  if (ab.x == null || ab.y == null) return;
  const active = document.getElementById("active-layer");
  const trail  = document.getElementById("trail-layer");
  const speedSec = +document.getElementById("dspeed").value;
  const traceDur = Math.min(speedSec * 0.6, 0.6);
  const fadeDur  = Math.max(speedSec * 1.2, 0.6);
  const c = colorFor(ab.result);
  const NS = "http://www.w3.org/2000/svg";
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", 160); line.setAttribute("y1", 320);
  line.setAttribute("x2", 160); line.setAttribute("y2", 320);
  line.setAttribute("stroke", c); line.setAttribute("stroke-width", "2"); line.setAttribute("opacity", "0.85");
  active.appendChild(line);
  const ball = document.createElementNS(NS, "circle");
  ball.setAttribute("cx", 160); ball.setAttribute("cy", 320);
  ball.setAttribute("r", 6); ball.setAttribute("fill", c); ball.setAttribute("opacity", "0.95");
  active.appendChild(ball);
  const startTime = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - startTime) / (traceDur * 1000));
    const ease = 1 - Math.pow(1 - t, 2);
    const x = 160 + (ab.x - 160) * ease;
    const y = 320 + (ab.y - 320) * ease;
    line.setAttribute("x2", x); line.setAttribute("y2", y);
    ball.setAttribute("cx", x); ball.setAttribute("cy", y);
    if (t < 1) { requestAnimationFrame(frame); return; }
    if (document.getElementById("dtrails").checked) {
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", ab.x); dot.setAttribute("cy", ab.y);
      dot.setAttribute("r", 4); dot.setAttribute("fill", c); dot.setAttribute("opacity", "0.6");
      dot.dataset.season = String(ab.season_year);
      dot.dataset.result = ab.result || "";
      dot.dataset.pt = ab.play_type || "";
      dot.dataset.zone = ab.field_zone || "";
      dot.dataset.side = ab.field_side || "";
      dot.dataset.rs = ab.run_scoring ? "true" : "false";
      dot.dataset.person = ab.person_key || "";
      trail.appendChild(dot);
      const dotAnim = dot.animate([{ opacity: 0.6, r: 4 }, { opacity: 0.18, r: 3 }], { duration: fadeDur * 1000 });
      dotAnim.onfinish = () => { dot.setAttribute("opacity", "0.18"); dot.setAttribute("r", "3"); };
    }
    if (document.getElementById("dlabels").checked) {
      const mode = document.querySelector("input[name=dmode]:checked").value;
      let lblText;
      if (mode === "career" && ab.date) {
        const d2 = new Date(ab.date + "T00:00:00");
        lblText = d2.toLocaleString("en-US", { month: "short", year: "numeric" });
      } else {
        lblText = ab.batter || "";
      }
      const lbl = document.createElementNS(NS, "text");
      lbl.setAttribute("x", ab.x + 6); lbl.setAttribute("y", ab.y);
      lbl.setAttribute("fill", "#e6e6e6"); lbl.setAttribute("font-size", "9");
      lbl.dataset.season = String(ab.season_year);
      lbl.dataset.result = ab.result || "";
      lbl.dataset.pt = ab.play_type || "";
      lbl.dataset.zone = ab.field_zone || "";
      lbl.dataset.side = ab.field_side || "";
      lbl.dataset.rs = ab.run_scoring ? "true" : "false";
      lbl.textContent = lblText;
      trail.appendChild(lbl);
      const lblAnim = lbl.animate([{ opacity: 0.9 }, { opacity: 0.15 }], { duration: fadeDur * 1000 });
      lblAnim.onfinish = () => lbl.setAttribute("opacity", "0.15");
    }
    ball.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: 250, fill: "forwards" });
    line.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: 350, fill: "forwards" });
    setTimeout(function() { ball.remove(); line.remove(); }, 400);
  }
  requestAnimationFrame(frame);
}

// ============= MVP TAB =============
const MVP_PERSON_KEYS = {};
function initMvp() {
  const root = document.getElementById("mvp-list");
  if (!root) return;
  const nights = DATA.mvp_nights || [];
  const seasonSel = document.getElementById("mvpSeason");
  const playerSel = document.getElementById("mvpPlayer");
  const seasons = [...new Set(nights.map(n => n.season_year))].sort();
  seasonSel.innerHTML = `<option value="all">All seasons</option>` + seasons.map(y => `<option value="${y}">${y}</option>`).join("");
  nights.forEach(n => (n.top||[]).forEach(p => { MVP_PERSON_KEYS[p.person_key] = p.display_name; }));
  const orderedKeys = Object.keys(MVP_PERSON_KEYS).sort((a,b) => MVP_PERSON_KEYS[a].localeCompare(MVP_PERSON_KEYS[b]));
  playerSel.innerHTML = `<option value="all">All players</option>` + orderedKeys.map(k => `<option value="${k}">${MVP_PERSON_KEYS[k]}</option>`).join("");
  seasonSel.onchange = renderMvpList;
  playerSel.onchange = renderMvpList;
  renderMvpList();
}

function renderMvpList() {
  const root = document.getElementById("mvp-list");
  if (!root) return;
  const nights = DATA.mvp_nights || [];
  const seasonF = document.getElementById("mvpSeason").value;
  const playerF = document.getElementById("mvpPlayer").value;
  let filtered = nights.slice();
  if (seasonF && seasonF !== "all") filtered = filtered.filter(n => String(n.season_year) === seasonF);
  if (playerF && playerF !== "all") filtered = filtered.filter(n => n.mvp && n.mvp.person_key === playerF);
  // Tally Tall Cans by player for the filtered slice
  const tally = {};
  filtered.forEach(n => { const k = n.mvp.person_key; tally[k] = (tally[k] || 0) + 1; });
  const tallyEl = document.getElementById("mvpTally");
  const tallyArr = Object.entries(tally).map(([k,v]) => ({ k, v, name: MVP_PERSON_KEYS[k] || k })).sort((a,b) => b.v - a.v);
  if (tallyEl) {
    tallyEl.innerHTML = tallyArr.length === 0
      ? "—"
      : tallyArr.slice(0, 8).map(t => `<div style="display:flex;justify-content:space-between;padding:2px 0;"><span>${t.name || t.k}</span><b>${t.v}🍺</b></div>`).join("");
  }
  if (filtered.length === 0) {
    root.innerHTML = `<div class="panel"><em style="color:#8a99a8">No nights match the current filter.</em></div>`;
    return;
  }
  root.innerHTML = filtered.map(renderNightCard).join("");
}

function renderNightCard(night) {
  const mvp = night.mvp;
  const oppText = night.opponents && night.opponents.length ? night.opponents.join(" / ") : "—";
  const dateLabel = formatNightDate(night.date);
  const others = (night.top || []).slice(1, 4).map(p =>
    `<div class="mvp-others-row"><span class="name">${p.display_name}</span><span>${p.H}-for-${p.AB}${p.HR?`, ${p.HR} HR`:""}${p.runs_scored?`, ${p.runs_scored}R`:""}</span><span style="margin-left:auto;color:#5a6772">${p.score.toFixed(1)}</span></div>`
  ).join("");
  return `<div class="mvp-night headlined">
    <div class="mvp-date">${dateLabel} · vs ${oppText}</div>
    <div class="mvp-headline"><span class="can">🍺</span> ${mvp.display_name}</div>
    <div class="mvp-just">${escapeHtml(night.justification)}</div>
    <div class="mvp-row">
      <span class="stat"><b>${mvp.H}</b>/${mvp.AB}</span>
      <span class="stat"><b>${mvp.TB}</b> TB</span>
      ${mvp.HR ? `<span class="stat"><b>${mvp.HR}</b> HR</span>` : ""}
      ${mvp.XBH ? `<span class="stat"><b>${mvp.XBH}</b> XBH</span>` : ""}
      ${mvp.runs_scored ? `<span class="stat"><b>${mvp.runs_scored}</b> runs</span>` : ""}
      <span class="stat" style="color:#8a99a8">score <b>${mvp.score.toFixed(1)}</b></span>
    </div>
    ${others ? `<div class="mvp-others"><div class="mvp-section-title">Also in contention</div>${others}</div>` : ""}
  </div>`;
}

function formatNightDate(d) {
  if (!d) return "?";
  const dd = new Date(d + "T00:00:00");
  return dd.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}

// Lazy-init the MVP tab on first click
(function() {
  const mvpTab = document.querySelector('.tab[data-tab="mvp"]');
  if (mvpTab) {
    mvpTab.addEventListener("click", () => {
      if (!window.__mvpInit) { window.__mvpInit = true; initMvp(); }
    });
  }
})();

</script>
</body>
</html>
"""


def main():
    bundle = load_pergame_bundle()
    by_player = build_players_map(bundle)
    career_a = {pk(c["display_name"]): c for c in bundle["career_weighted"]}
    at_bats = build_at_bats()

    mvp_nights = build_mvp_nights(at_bats)
    embedded = {
        "players": by_player,
        "career_weighted": career_a,
        "weights": bundle["weights"],
        "at_bats": at_bats,
        "mvp_nights": mvp_nights,
    }

    # Recursively scrub NaN/Inf so the embedded literal is pure JSON (no bare `NaN` tokens).
    def scrub(o):
        if isinstance(o, float):
            if math.isnan(o) or math.isinf(o): return None
            return o
        if isinstance(o, dict):
            return {k: scrub(v) for k, v in o.items()}
        if isinstance(o, list):
            return [scrub(v) for v in o]
        return o

    embedded = scrub(embedded)

    with open(TEMPLATE, "r", encoding="utf-8") as f:
        template = f.read()

    # The viewer_template.html occasionally gets its tail truncated by external
    # tooling, especially inside the long animateAtBat function. Self-heal by
    # strip-back-and-replace: find the `function animateAtBat` header, drop
    # everything from there onward, then inject a known-good tail.
    cut_marker = "function animateAtBat(ab) {"
    idx = template.find(cut_marker)
    if idx != -1:
        template = template[:idx]
    # Drop any trailing closing tags that may already be there so we don't double them.
    for tag in ("</html>", "</body>", "</script>"):
        template = template.rstrip()
        if template.endswith(tag):
            template = template[:-len(tag)].rstrip()
    template = template.rstrip() + "\n\n" + ANIMATE_AT_BAT_TAIL + "\n"
    html = template.replace("__DATA__", json.dumps(embedded, allow_nan=False))

    # ------------------------------------------------------------------
    # JS hang check — extract every inline <script> and syntax-validate
    # via `node --check`. Refuse to write the HTML if any block fails so
    # the page never silently hangs in the browser.
    # ------------------------------------------------------------------
    import re, subprocess, tempfile
    errors = []
    opens  = sum(1 for _ in re.finditer(r"<script(?:\s|>)", html))
    closes = html.count("</script>")
    if opens != closes:
        errors.append(f"unbalanced <script> tags: {opens} open, {closes} close")
    for i, m in enumerate(re.finditer(r"<script(?:\s[^>]*)?>(.*?)</script>", html, re.DOTALL)):
        open_tag = html[m.start():m.start(1)]
        if "src=" in open_tag:
            continue
        body = m.group(1)
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(body); tmp = f.name
        res = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
        if res.returncode != 0:
            tail = (res.stderr or res.stdout).strip().splitlines()[-3:]
            errors.append(f"inline script #{i} parse error: " + " | ".join(tail))
            continue
        # Smoke-execute: stub TOP (globals) -> body -> stub BOTTOM (call inits)
        stub_top = os.path.join(HERE, "_smoke_stub.js")
        stub_bottom = os.path.join(HERE, "_smoke_stub_bottom.js")
        if os.path.exists(stub_top) and os.path.exists(stub_bottom):
            top = open(stub_top).read()
            bot = open(stub_bottom).read()
            with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
                f.write(top + "\n" + body + "\n" + bot); smoke_path = f.name
            res2 = subprocess.run(["node", smoke_path], capture_output=True, text=True, timeout=10)
            if res2.returncode != 0:
                tail_lines = (res2.stderr or res2.stdout).strip().splitlines()
                useful = [l for l in tail_lines if any(k in l for k in ("Error", "RangeError", "TypeError", "ReferenceError"))][:3]
                errors.append(f"inline script #{i} runtime error: " + " | ".join(useful or tail_lines[:2]))
    if errors:
        print("JS validation FAILED - refusing to ship HTML:")
        for e in errors: print("   ", e)
        raise SystemExit(1)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    msg = "wrote " + OUT + " (" + str(round(len(html)/1024)) + " KB, " + str(len(at_bats)) + " at-bats, " + str(len(mvp_nights)) + " MVP nights)"
    print("JS check passed. " + msg)


if __name__ == "__main__":
    main()
