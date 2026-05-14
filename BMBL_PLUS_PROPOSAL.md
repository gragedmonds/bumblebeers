# BMBL+ — A composite ranking for Bumblebeers offensive performance

A proposed multi-factor player evaluation that produces a single, comparable score per
player per season (with a career roll-up), built from data we already have.

---

## 1. What we have to work with

Two complementary data sources:

**A. Season-stats (per player per season, from GameChanger's `season-stats` endpoint)**
Holds 80+ offensive fields including PA, AB, H, 1B, 2B, 3B, HR, BB, HBP, SO, SB, CS, R,
RBI, TB, XBH, SHF/SHB, GSHR, AVG, OBP, SLG, OPS, BABIP, AB/HR, **BA/RISP, ABRISP, HRISP,
2OUTRBI**, LOB, LOBB, 3OUTLOB, QAB/QAB%, HARD/WEAK, LND/FLB/GB and their %s, PA/BB,
6+/6+%, 2STRIKES, FULL, PS, PS/PA, swing/miss/contact percentages, GIDP, GITP, PIK,
ROE, FC, and more.

**B. Play-by-play at-bats (per at-bat, from the raw scrape)**
Every BMBL at-bat with result, play type, fielder position + coordinates, pitch sequence,
baserunning events. Lets us compute things the season-stats doesn't expose — context
splits like "wOBA in close games", batted-ball spray, fielder-position heatmaps.

**Reconciliation policy:** Whenever both sources give the same number (e.g., total
hits), the season-stats value is treated as ground truth and the raw data is used to
verify or extend it. Any divergence > 5% is flagged on a "Reconciliation" sheet so we
can investigate (usually a scorer skipping at-bats in pbp but logging the totals).

---

## 2. The BMBL+ score

```
BMBL+ = 100  +  25 × Σ ( weight_i × z_i )
```

- **100 = team-season average**. The score is centered on each season's own team so
  era effects (rule changes, league strength, scorer style) don't pollute comparisons.
- **25 points = one within-season standard deviation**. So 125 ≈ top-quartile,
  150 ≈ MVP-level, 75 ≈ bottom-quartile.
- **z_i = z-score of component i within that season** (so it's already a relative
  measure within the team).
- **Σ weights = 1.00.**

### Component weights

| Tier | Component | Weight | What it measures |
|------|-----------|------:|------------------|
| **Production** | wOBA (linear-weighted offence) | **40%** | Overall run-creation per PA |
| **Power**      | ISO (SLG − AVG)                | **10%** | Extra-base ability |
| **Clutch**     | RISP performance differential   | **10%** | Lifts in RBI spots vs. own baseline |
| **Clutch**     | 2-out RBI rate                  |  **8%** | Productive in worst-leverage spots |
| **Clutch**     | Productive-out rate             |  **7%** | Sac flies, sac bunts, advances |
| **Discipline** | Strikeout avoidance (1 − K/PA) |  **5%** | Doesn't waste a PA |
| **Discipline** | Walk rate (BB/PA)              |  **5%** | Earns free passes |
| **Discipline** | Quality At-Bat %               |  **5%** | GC's QAB metric |
| **Contact**    | Hard contact %                 |  **6%** | HARD / (HARD+WEAK) |
| **Contact**    | Line drive %                   |  **4%** | LND / INP |
|                | **Total**                       | **100%** | |

### Formula details

**wOBA** (linear weights tuned for adult slo-pitch — fewer walks, more BIP, but the
shape of run values is the same as baseball):

```
wOBA = (0.69·BB + 0.72·HBP + 0.88·1B + 1.25·2B + 1.58·3B + 2.10·HR) / (AB + BB + HBP + SF)
```

We can refine these weights later by regressing run scoring against the events in the
raw data — see "Future work" below.

**ISO** = SLG − AVG. Equivalent to TB/AB − H/AB = (2B + 2·3B + 3·HR) / AB.

**RISP differential** = (HRISP / ABRISP) − AVG. Players who *rise* with RISP score
above zero; players who *shrink* score below. Z-scored across the team.

**2-out RBI rate** = 2OUTRBI / PA. This is the highest-leverage RBI category — drives in
runs when the inning is on the brink.

**Productive-out rate** = (SHF + SHB + ROE-credit + advances during outs) / PA. We
approximate using `(SHF + SHB + "batter_out_advance_runners" count from raw) / PA` so
we capture moving runners over without official sac credit.

**Strikeout avoidance** = 1 − (SO/PA). Inverted so higher is better.

**Walk rate** = BB / PA.

**Quality At-Bat %** = QAB / PA (GameChanger's QAB definition: 6+ pitch AB, hard-hit
ball, walk, sac, RBI, productive out, etc.).

**Hard %** = HARD / (HARD + WEAK). We can also use HARD / INP.

**LD %** = LND / INP.

---

## 3. Sample-size handling

Two complementary techniques:

1. **Qualification threshold.** A player needs **≥ 25 PA in a season** to receive a
   *qualified* BMBL+. Below 25 PA they're still shown with the score, but flagged
   "small sample" and excluded from rankings.
2. **Bayesian shrinkage** for the wOBA component (the one most sensitive to sample
   size):

   ```
   wOBA_eff = (PA · wOBA_player + k · wOBA_team) / (PA + k)        where k = 50
   ```

   This pulls Mark's 7-PA hot streak back toward the team mean without erasing his
   actual production. The other rate stats are noisy on small samples but less
   distorting, so we leave them un-shrunk and let the PA filter handle it.

---

## 4. Output deliverables

A new Excel workbook **`bumblebeers_rankings.xlsx`** with these sheets:

| Sheet | Content |
|---|---|
| **Summary** | One row per player-season: PA, AVG/OBP/SLG/OPS, RISP, 2OUTRBI, K%, BB%, QAB%, Hard%, **BMBL+**, season rank |
| **Components** | Full breakdown — each component's raw value, z-score, weighted contribution |
| **Year by Year** | Per-season top-10 lists, side by side |
| **Career** | PA-weighted average BMBL+, plus peak-season highlight, count of "qualified" seasons |
| **Reconciliation** | Season-stats vs raw-pbp comparison for AVG/HR/RBI/BB/SO with discrepancy flags |
| **Raw Stats** | Full season-stats dump, all 80+ fields, for ad-hoc analysis |
| **Weights** | Editable cells with current weights, so you can override and recompute |

The script `build_rankings.py` will let you change the weights at the top and re-run
to see how the leaderboard shifts. (e.g., crank Clutch to 50% if you care more about
RBI guys than pure on-base machines.)

---

## 5. What this is and is not

**What it is:** a transparent, defendable composite that rewards what a manager
intuitively cares about — getting on, hitting for power, coming through in the spot
that matters, and not wasting at-bats — calibrated to the team and season.

**What it isn't:** a fielding or baserunning ranking. Baserunning could be added later
(SB rate, taking the extra base, getting picked off) but offence-only is a clean v1.
Defense data from the raw plays could power a separate F-BMBL+.

---

## 6. Future work (after v1 ships)

1. **Calibrate linear weights from our own data.** Run a regression of half-inning runs
   on event counts to derive Bumblebeers-specific wOBA weights instead of borrowing
   baseball's. We have ~5,000 BMBL at-bats — enough to fit reliably.
2. **Close-game leverage index.** Use the override score events from raw plays to tag
   each at-bat with a leverage value (à la FanGraphs' LI), then build a Clutch+
   sub-score that's stricter than RISP.
3. **Spray charts and "expected" hits** based on fielder position from raw at-bats —
   gives us xwOBA, so we can separate true talent from BABIP luck.
4. **Career age curve.** Once we have enough seasons per player, fit an age curve and
   produce projections.
5. **Head-to-head matchups.** Filter to a specific opponent (e.g., career stats vs.
   Mets) using the at-bat data.

---

## 7. Open decisions for you

Before I build it, two things to confirm:

1. **Weights.** Above is a starting point. Heavier on Clutch? Lighter on Power? Speak
   now or fiddle in the spreadsheet later.
2. **PA threshold.** 25 PA per season for qualification — reasonable? Some early
   seasons had 30-32 games so 25 PA ≈ ~7 games of regular play. We could go lower
   (15) or use a games-played threshold (e.g., GP ≥ 8).
3. **Career roll-up basis.** Average of BMBL+ weighted by PA, **or** recompute BMBL+
   directly on lifetime totals? They give slightly different answers; the first
   rewards consistency, the second rewards peak-volume seasons.
