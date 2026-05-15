"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSnapshot } from "@/lib/useSnapshot";
import type { AtBat, BaseSnapshot, RunnerMove } from "@/lib/data";

const SVG_NS = "http://www.w3.org/2000/svg";

// Base-marker coordinates on the SVG viewport (must match the field <rect>s below).
const BASE_POSITIONS: Record<1 | 2 | 3, { x: number; y: number }> = {
  1: { x: 285, y: 205 },
  2: { x: 160, y: 90 },
  3: { x: 35, y: 205 },
};
const HOME_PLATE = { x: 160, y: 320 };
const RUNNER_DOT_COLOR = "#b45309"; // amber-700, matches the bee theme

// Point lookups by base-id. 0 = batter's box (= home plate for animation
// purposes), 1/2/3 = field bases, 4 = scored (animate to home then disappear).
const BASE_POINT: Record<0 | 1 | 2 | 3 | 4, { x: number; y: number }> = {
  0: HOME_PLATE,
  1: BASE_POSITIONS[1],
  2: BASE_POSITIONS[2],
  3: BASE_POSITIONS[3],
  4: HOME_PLATE,
};

// Dugout: where runners go when they're put out on the basepaths. Off-field
// down the third-base line — out of the way of the active diamond.
const DUGOUT_POINT = { x: -60, y: 400 };

/** One runner currently sitting on the diamond. Lives in the persistent base
 * layer across consecutive at-bats in the same half-inning.
 *
 * `genId` is the cancellation token. Any pending tween / fade captures the
 * current value at start; on every animation frame it re-checks against the
 * runner's live `genId` and bails if they don't match. New operations on the
 * same runner (a fresh tween, a hard-wipe, or a same-inning reconciliation
 * relocate) bump `genId`, which retires every pending animation that was
 * targeting this runner. Without this, fast playback (speed < tween
 * duration) used to leave runners stranded mid-base because two tweens
 * would race on the same DOM nodes. */
interface RunnerSquare {
  name: string;
  base: 0 | 1 | 2 | 3; // last known stationary base
  rect: SVGRectElement;
  label: SVGTextElement;
  genId: number;
}

const RUNNER_SQUARE_SIZE = 18;
const RUNNER_HALF = RUNNER_SQUARE_SIZE / 2;
// Below this speed (s/play) we skip the runner-motion tweens entirely and
// snap squares directly to their target bases. The tween itself is ~450ms,
// so anything faster than ~0.5 s/play won't have time to render meaningful
// motion before the next AB cancels it — and the cancelled-mid-flight
// state was the source of the "stuck runner" bug Greg saw at fast speeds.
const TWEEN_MIN_SPEED = 0.5;

function runnerKey(name: string): string {
  // First-name-collision risk for our small team is low; if it becomes one,
  // bake person_key into the move payload instead of display name.
  return name.trim().toLowerCase();
}

function createRunnerSquare(
  layer: SVGGElement,
  name: string,
  base: 0 | 1 | 2 | 3,
): RunnerSquare {
  const { x, y } = BASE_POINT[base];
  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", String(x - RUNNER_HALF));
  rect.setAttribute("y", String(y - RUNNER_HALF));
  rect.setAttribute("width", String(RUNNER_SQUARE_SIZE));
  rect.setAttribute("height", String(RUNNER_SQUARE_SIZE));
  rect.setAttribute("rx", "2");
  rect.setAttribute("fill", RUNNER_DOT_COLOR);
  rect.setAttribute("stroke", "#fff");
  rect.setAttribute("stroke-width", "2");
  rect.setAttribute("opacity", "0.95");
  layer.appendChild(rect);

  const label = document.createElementNS(SVG_NS, "text");
  // Push label outward from the diamond center so it doesn't sit on the dirt.
  const labelOffsetY = base === 2 ? -14 : 18;
  label.setAttribute("x", String(x));
  label.setAttribute("y", String(y + labelOffsetY));
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("fill", "#3b2e10");
  label.setAttribute("font-size", "11");
  label.setAttribute("font-weight", "600");
  label.setAttribute("paint-order", "stroke");
  label.setAttribute("stroke", "#fff");
  label.setAttribute("stroke-width", "3");
  label.setAttribute("opacity", "0.95");
  label.textContent = name;
  layer.appendChild(label);

  return { name, base, rect, label, genId: 0 };
}

/** Snap a runner directly to a base, no animation. Used at fast playback
 * speeds and when reconciliation finds a runner on the wrong base. Bumps
 * genId so any pending tween for this runner aborts on its next frame. */
function snapRunnerTo(runner: RunnerSquare, base: 0 | 1 | 2 | 3) {
  runner.genId++;
  const { x, y } = BASE_POINT[base];
  const labelOffsetY = base === 2 ? -14 : 18;
  runner.rect.setAttribute("x", String(x - RUNNER_HALF));
  runner.rect.setAttribute("y", String(y - RUNNER_HALF));
  runner.label.setAttribute("x", String(x));
  runner.label.setAttribute("y", String(y + labelOffsetY));
  runner.base = base;
}

/** Synchronously tear down a runner's DOM + retire any in-flight tween. */
function killRunner(runner: RunnerSquare) {
  runner.genId++;
  runner.rect.remove();
  runner.label.remove();
}

/** Single-segment tween. Captures `gen` at start; bails on any frame where
 * the runner's live genId no longer matches. */
function tweenRunnerToPoint(
  runner: RunnerSquare,
  target: { x: number; y: number },
  labelOffsetY: number,
  ms: number,
  gen: number,
): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const fromX = parseFloat(runner.rect.getAttribute("x") || "0") + RUNNER_HALF;
    const fromY = parseFloat(runner.rect.getAttribute("y") || "0") + RUNNER_HALF;
    const fromLblY = parseFloat(runner.label.getAttribute("y") || "0");
    const targetLblY = target.y + labelOffsetY;
    function frame(now: number) {
      if (runner.genId !== gen) {
        resolve();
        return;
      }
      const t = Math.min(1, (now - start) / ms);
      const ease = 1 - Math.pow(1 - t, 2);
      const x = fromX + (target.x - fromX) * ease;
      const y = fromY + (target.y - fromY) * ease;
      runner.rect.setAttribute("x", String(x - RUNNER_HALF));
      runner.rect.setAttribute("y", String(y - RUNNER_HALF));
      runner.label.setAttribute("x", String(x));
      const lblY = fromLblY + (targetLblY - fromLblY) * ease;
      runner.label.setAttribute("y", String(lblY));
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

/** Smoothly tween a runner square through the basepaths chronologically.
 * Runners never cut across the infield — going from 2B to home goes
 * through 3B; going from 1B to 3B goes through 2B. The total animation
 * time is split evenly across however many segments are needed. */
async function tweenRunner(
  runner: RunnerSquare,
  fromBase: 0 | 1 | 2 | 3,
  toBase: 1 | 2 | 3 | 4,
  totalMs: number,
): Promise<void> {
  const gen = ++runner.genId;
  const path: (1 | 2 | 3 | 4)[] = [];
  for (let b = fromBase + 1; b <= toBase; b++) {
    path.push(b as 1 | 2 | 3 | 4);
  }
  if (path.length === 0) return;
  const segmentMs = Math.max(80, Math.floor(totalMs / path.length));
  for (const seg of path) {
    if (runner.genId !== gen) return;
    const target = BASE_POINT[seg];
    const offset = seg === 2 ? -14 : 18;
    await tweenRunnerToPoint(runner, target, offset, segmentMs, gen);
  }
}

/** Send a runner to the dugout (off-field) with a little arc, then fade. */
async function tweenRunnerToDugout(
  runner: RunnerSquare,
  totalMs: number,
): Promise<void> {
  const gen = ++runner.genId;
  await tweenRunnerToPoint(runner, DUGOUT_POINT, 18, totalMs, gen);
  if (runner.genId !== gen) return;
  await fadeAndRemoveRunner(runner, 250, gen);
}

/** Fade a runner's rect + label to zero opacity and remove from DOM.
 * If a `gen` is supplied, fade aborts (without removing) when superseded;
 * if not, takes ownership by bumping a fresh gen of its own. */
function fadeAndRemoveRunner(
  runner: RunnerSquare,
  ms: number,
  gen?: number,
): Promise<void> {
  const myGen = gen ?? ++runner.genId;
  return new Promise((resolve) => {
    const start = performance.now();
    const fromR = parseFloat(runner.rect.getAttribute("opacity") || "1");
    const fromL = parseFloat(runner.label.getAttribute("opacity") || "1");
    function frame(now: number) {
      if (runner.genId !== myGen) {
        resolve();
        return;
      }
      const t = Math.min(1, (now - start) / ms);
      runner.rect.setAttribute("opacity", String(fromR * (1 - t)));
      runner.label.setAttribute("opacity", String(fromL * (1 - t)));
      if (t < 1) requestAnimationFrame(frame);
      else {
        runner.rect.remove();
        runner.label.remove();
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

function clearAllRunners(
  map: Map<string, RunnerSquare>,
  fadeMs = 200,
): Promise<void[]> {
  const all = [...map.values()];
  map.clear();
  return Promise.all(all.map((r) => fadeAndRemoveRunner(r, fadeMs)));
}

/** Re-seed the persistent base layer from a known-good snapshot (used when
 * the half-inning changes and we can't trust the carry-over state). */
function seedRunnersFromSnapshot(
  layer: SVGGElement,
  map: Map<string, RunnerSquare>,
  snap: { "1": string | null; "2": string | null; "3": string | null },
) {
  for (const b of [1, 2, 3] as const) {
    const name = snap[String(b) as "1" | "2" | "3"];
    if (!name) continue;
    const r = createRunnerSquare(layer, name, b);
    map.set(runnerKey(name), r);
  }
}

// Per-batter handedness map. Loaded at runtime from /api/lineup so it
// stays in sync with what Greg sets on the Lineup page. Anyone not in
// the map defaults to "R" for spray classification.
type HandednessMap = Record<string, "L" | "R">;

/** Derived per-AB context. Computed once over the whole at-bat list (not
 * the filtered sequence) so chips and tooltips reflect what was actually
 * happening in the game, regardless of which view filter is active. */
interface AtBatDerived {
  outs_before: 0 | 1 | 2 | 3;
  risp: boolean;
  loaded: boolean;
  leadoff: boolean;
  frame: number; // 1-based; parsed from "<gameid>:<frame>" in half_inning_id
  late_inning: boolean; // frame >= 5 (slo-pitch is 6–7 innings)
  big_inning: boolean; // half-inning total runs >= 5
  productive_out: boolean; // batter out, but advanced a runner or scored one
  walk_off: boolean; // last AB of the game with a run scored (best guess)
  spray: "pull" | "push" | "middle" | "other";
}

type DecoratedAtBat = AtBat & { d: AtBatDerived };

const RESULT_COLORS: Record<string, string> = {
  single: "#69d68f",
  double: "#3aaaff",
  triple: "#c084fc",
  home_run: "#ffd24a",
  sacrifice_fly: "#94a3b8",
  fielders_choice: "#fb923c",
  error: "#a3e635",
  batter_out: "#ef4444",
  batter_out_advance_runners: "#ef4444",
  infield_fly: "#dc2626",
  other_out: "#b91c1c",
  dropped_third_strike_batter_out: "#b91c1c",
  strike_out: "#b91c1c",
};

const OUT_RESULTS = new Set([
  "batter_out",
  "batter_out_advance_runners",
  "infield_fly",
  "other_out",
  "dropped_third_strike_batter_out",
  "strike_out",
]);

function colorFor(result: string | null | undefined): string {
  return (result && RESULT_COLORS[result]) || "#8a99a8";
}

function parseFrame(halfInningId: string | null): number {
  if (!halfInningId) return 0;
  const colon = halfInningId.lastIndexOf(":");
  if (colon < 0) return 0;
  const n = parseInt(halfInningId.slice(colon + 1), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Decorate every AB with derived situational context. Two passes:
 *   1. Group by half_inning_id, sort by transaction_seq, walk forward
 *      tracking outs and accumulating total runs scored in the frame.
 *   2. Group by event_id (game), find the last AB of each game, mark it
 *      as walk_off if it scored a run.
 * O(n log n) one-time cost — re-runs only when snapshot.at_bats changes. */
function decorateAtBats(atbats: AtBat[], handedness: HandednessMap = {}): DecoratedAtBat[] {
  const outsBefore = new Map<AtBat, 0 | 1 | 2 | 3>();
  const halfRuns = new Map<string, number>();

  const byHalfInning = new Map<string, AtBat[]>();
  for (const ab of atbats) {
    const key = ab.half_inning_id ?? "?";
    let bucket = byHalfInning.get(key);
    if (!bucket) {
      bucket = [];
      byHalfInning.set(key, bucket);
    }
    bucket.push(ab);
  }
  for (const [key, bucket] of byHalfInning) {
    bucket.sort((a, b) => a.transaction_seq - b.transaction_seq);
    let outs = 0;
    let runs = 0;
    for (const ab of bucket) {
      outsBefore.set(ab, Math.min(outs, 3) as 0 | 1 | 2 | 3);
      if (OUT_RESULTS.has(ab.result || "")) outs++;
      runs += ab.runs_scored || 0;
    }
    halfRuns.set(key, runs);
  }

  const byGame = new Map<string, AtBat[]>();
  for (const ab of atbats) {
    const key = ab.event_id ?? "?";
    let bucket = byGame.get(key);
    if (!bucket) {
      bucket = [];
      byGame.set(key, bucket);
    }
    bucket.push(ab);
  }
  const walkOffs = new Set<AtBat>();
  for (const bucket of byGame.values()) {
    bucket.sort((a, b) => a.transaction_seq - b.transaction_seq);
    const last = bucket[bucket.length - 1];
    if (!last) continue;
    if (last.run_scoring || (last.runs_scored ?? 0) > 0) walkOffs.add(last);
  }

  return atbats.map((ab) => {
    const ob = outsBefore.get(ab) ?? 0;
    const before = ab.runners_before ?? { "1": null, "2": null, "3": null };
    const onBases = (["1", "2", "3"] as const).filter((b) => before[b]);
    const risp = !!(before["2"] || before["3"]);
    const loaded = !!(before["1"] && before["2"] && before["3"]);
    const leadoff = ob === 0 && onBases.length === 0;
    const frame = parseFrame(ab.half_inning_id);
    const late_inning = frame >= 5;
    const totalRuns = halfRuns.get(ab.half_inning_id ?? "?") ?? 0;
    const big_inning = totalRuns >= 5;
    const isOut = OUT_RESULTS.has(ab.result || "");
    const moves = ab.runner_moves ?? [];
    const advanced = moves.some(
      (m) =>
        m.from > 0 &&
        typeof m.to === "number" &&
        (m.to as number) > (m.from as number),
    );
    const productive_out = isOut && ((ab.runs_scored ?? 0) > 0 || advanced);
    const handed = handedness[ab.person_key] ?? "R";
    const side = ab.field_side;
    let spray: AtBatDerived["spray"];
    if (side === "middle") spray = "middle";
    else if (side === "left") spray = handed === "L" ? "push" : "pull";
    else if (side === "right") spray = handed === "R" ? "push" : "pull";
    else spray = "other";

    return {
      ...ab,
      d: {
        outs_before: ob,
        risp,
        loaded,
        leadoff,
        frame,
        late_inning,
        big_inning,
        productive_out,
        walk_off: walkOffs.has(ab),
        spray,
      },
    };
  });
}

type Mode = "career" | "season" | "all";

type Preset =
  | "all"
  | "hits"
  | "xbh"
  | "hr"
  | "runs"
  | "of_hits"
  | "if_hits"
  | "outs"
  | "line_drives"
  | "ground_balls"
  | "left"
  | "right"
  | "middle";

type Filters = {
  result: Set<string>;
  playType: Set<string>;
  zone: Set<string>;
  side: Set<string>;
  onlyRuns: boolean;
};

const DEFAULT_RESULTS = new Set([
  "single",
  "double",
  "triple",
  "home_run",
  "outs",
  "sacrifice_fly",
  "fielders_choice",
  "error",
]);
const DEFAULT_PLAY_TYPES = new Set([
  "line_drive",
  "fly_ball",
  "ground_ball",
  "pop_fly",
  "bunt",
]);
const DEFAULT_ZONES = new Set(["infield", "outfield"]);
const DEFAULT_SIDES = new Set(["left", "middle", "right"]);

function defaultFilters(): Filters {
  return {
    result: new Set(DEFAULT_RESULTS),
    playType: new Set(DEFAULT_PLAY_TYPES),
    zone: new Set(DEFAULT_ZONES),
    side: new Set(DEFAULT_SIDES),
    onlyRuns: false,
  };
}

function applyPreset(p: Preset): Filters {
  const f = defaultFilters();
  if (p === "hits") f.result = new Set(["single", "double", "triple", "home_run"]);
  else if (p === "xbh") f.result = new Set(["double", "triple", "home_run"]);
  else if (p === "hr") f.result = new Set(["home_run"]);
  else if (p === "runs") f.onlyRuns = true;
  else if (p === "of_hits") {
    f.result = new Set(["single", "double", "triple", "home_run"]);
    f.zone = new Set(["outfield"]);
  } else if (p === "if_hits") {
    f.result = new Set(["single", "double", "triple", "home_run"]);
    f.zone = new Set(["infield"]);
  } else if (p === "outs") f.result = new Set(["outs"]);
  else if (p === "line_drives") f.playType = new Set(["line_drive"]);
  else if (p === "ground_balls") f.playType = new Set(["ground_ball"]);
  else if (p === "left") f.side = new Set(["left"]);
  else if (p === "right") f.side = new Set(["right"]);
  else if (p === "middle") f.side = new Set(["middle"]);
  return f;
}

function passesFilters(ab: AtBat, f: Filters): boolean {
  const r = ab.result || "";
  const inResult =
    f.result.has(r) || (f.result.has("outs") && OUT_RESULTS.has(r));
  if (!inResult) return false;
  const pt = ab.play_type || "";
  const inPt =
    f.playType.has(pt) ||
    (f.playType.has("ground_ball") && pt === "hard_ground_ball") ||
    (f.playType.has("bunt") && (pt === "bunt" || pt === "other"));
  if (!inPt) return false;
  if (!f.zone.has(ab.field_zone || "infield")) return false;
  if (!f.side.has(ab.field_side || "middle")) return false;
  if (f.onlyRuns && !ab.run_scoring) return false;
  return true;
}

function setDataset(el: SVGElement, key: string, val: string) {
  el.setAttribute("data-" + key, val);
}

function stampMetadata(el: SVGElement, ab: DecoratedAtBat, abi?: number) {
  setDataset(el, "season", String(ab.season_year));
  setDataset(el, "result", ab.result || "");
  setDataset(el, "pt", ab.play_type || "");
  setDataset(el, "zone", ab.field_zone || "");
  setDataset(el, "side", ab.field_side || "");
  setDataset(el, "rs", ab.run_scoring ? "true" : "false");
  setDataset(el, "person", ab.person_key || "");
  // Derived chips.
  setDataset(el, "outs", String(ab.d.outs_before));
  setDataset(el, "risp", ab.d.risp ? "true" : "false");
  setDataset(el, "loaded", ab.d.loaded ? "true" : "false");
  setDataset(el, "leadoff", ab.d.leadoff ? "true" : "false");
  setDataset(el, "frame", String(ab.d.frame));
  setDataset(el, "lateinn", ab.d.late_inning ? "true" : "false");
  setDataset(el, "biginn", ab.d.big_inning ? "true" : "false");
  setDataset(el, "prodout", ab.d.productive_out ? "true" : "false");
  setDataset(el, "walkoff", ab.d.walk_off ? "true" : "false");
  setDataset(el, "spray", ab.d.spray);
  setDataset(
    el,
    "rbi",
    (ab.runs_scored ?? 0) >= 2 ? "multi" : (ab.runs_scored ?? 0) === 1 ? "single" : "none",
  );
  // Index into the current rendered sequence — used by the hover tooltip
  // to look the AB back up.
  if (abi != null) setDataset(el, "abi", String(abi));
}

function paintMarker(
  trail: SVGGElement,
  ab: DecoratedAtBat,
  showLabel: boolean,
  labelText: string,
  initial = true,
  abi?: number,
) {
  if (ab.x == null || ab.y == null) return null;
  const c = colorFor(ab.result || undefined);
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", String(ab.x));
  dot.setAttribute("cy", String(ab.y));
  dot.setAttribute("r", initial ? "4" : "3");
  dot.setAttribute("fill", c);
  dot.setAttribute("opacity", initial ? "0.6" : "0.18");
  stampMetadata(dot, ab, abi);
  trail.appendChild(dot);
  if (showLabel) {
    const lbl = document.createElementNS(SVG_NS, "text");
    lbl.setAttribute("x", String(ab.x + 6));
    lbl.setAttribute("y", String(ab.y));
    lbl.setAttribute("fill", "#1f2937");
    lbl.setAttribute("font-size", "9");
    lbl.setAttribute("opacity", initial ? "0.9" : "0.4");
    stampMetadata(lbl, ab, abi);
    lbl.textContent = labelText;
    trail.appendChild(lbl);
    return { dot, lbl };
  }
  return { dot, lbl: null };
}

function paintRunners(
  active: SVGGElement,
  runners: { 1: string | null; 2: string | null; 3: string | null },
): SVGElement[] {
  const created: SVGElement[] = [];
  (Object.keys(BASE_POSITIONS) as unknown as Array<1 | 2 | 3>).forEach((b) => {
    const key = b as 1 | 2 | 3;
    const name = runners[key];
    if (!name) return;
    const { x, y } = BASE_POSITIONS[key];
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y));
    dot.setAttribute("r", "8");
    dot.setAttribute("fill", RUNNER_DOT_COLOR);
    dot.setAttribute("stroke", "#fff");
    dot.setAttribute("stroke-width", "2");
    dot.setAttribute("opacity", "0.95");
    active.appendChild(dot);
    created.push(dot);
    const lbl = document.createElementNS(SVG_NS, "text");
    // Push label outward away from the diamond center so it doesn't overlap dirt.
    const labelOffsetY = key === 2 ? -14 : 18;
    lbl.setAttribute("x", String(x));
    lbl.setAttribute("y", String(y + labelOffsetY));
    lbl.setAttribute("text-anchor", "middle");
    lbl.setAttribute("fill", "#3b2e10");
    lbl.setAttribute("font-size", "11");
    lbl.setAttribute("font-weight", "600");
    lbl.setAttribute("paint-order", "stroke");
    lbl.setAttribute("stroke", "#fff");
    lbl.setAttribute("stroke-width", "3");
    lbl.setAttribute("opacity", "0.95");
    lbl.textContent = name;
    active.appendChild(lbl);
    created.push(lbl);
  });
  return created;
}

function flashHome(active: SVGGElement, runs: number): SVGElement[] {
  const created: SVGElement[] = [];
  // Two concentric rings expand outward from home plate.
  for (let i = 0; i < 2; i++) {
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("cx", String(HOME_PLATE.x));
    ring.setAttribute("cy", String(HOME_PLATE.y));
    ring.setAttribute("r", "10");
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", "#ffd24a");
    ring.setAttribute("stroke-width", "3");
    ring.setAttribute("opacity", "0.95");
    active.appendChild(ring);
    created.push(ring);
    const anim = ring.animate(
      [
        { r: "10", opacity: 0.95, strokeWidth: 3 },
        { r: "40", opacity: 0, strokeWidth: 1 },
      ] as unknown as Keyframe[],
      { duration: 900, delay: i * 220, fill: "forwards" },
    );
    anim.onfinish = () => ring.remove();
  }
  // Floating "+N RUN" badge above home plate.
  const badge = document.createElementNS(SVG_NS, "text");
  badge.setAttribute("x", String(HOME_PLATE.x));
  badge.setAttribute("y", String(HOME_PLATE.y - 18));
  badge.setAttribute("text-anchor", "middle");
  badge.setAttribute("fill", "#92400e");
  badge.setAttribute("font-size", "16");
  badge.setAttribute("font-weight", "800");
  badge.setAttribute("paint-order", "stroke");
  badge.setAttribute("stroke", "#fff");
  badge.setAttribute("stroke-width", "3");
  badge.textContent = `+${runs} RUN${runs === 1 ? "" : "S"}`;
  active.appendChild(badge);
  created.push(badge);
  const badgeAnim = badge.animate(
    [
      { opacity: 1, transform: `translate(0px, 0px)` },
      { opacity: 0, transform: `translate(0px, -22px)` },
    ] as unknown as Keyframe[],
    { duration: 1200, fill: "forwards" },
  );
  badgeAnim.onfinish = () => badge.remove();
  return created;
}

function fadeMarker(
  el: SVGElement,
  fadeMs: number,
  toOpacity: number,
  toR?: number,
) {
  const start = performance.now();
  const fromOpacity = parseFloat(el.getAttribute("opacity") || "0.6");
  const fromR = el.tagName === "circle"
    ? parseFloat(el.getAttribute("r") || "4")
    : undefined;
  function frame(now: number) {
    const t = Math.min(1, (now - start) / fadeMs);
    el.setAttribute(
      "opacity",
      String(fromOpacity + (toOpacity - fromOpacity) * t),
    );
    if (fromR != null && toR != null) {
      el.setAttribute("r", String(fromR + (toR - fromR) * t));
    }
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

export default function Diamond() {
  const { snapshot, error } = useSnapshot();
  // Pull the handedness map from the shared lineup blob so the Pulled /
  // Pushed chips reflect what Greg has set on /lineup. Best-effort — if
  // /api/lineup is down, defaults make everyone righty.
  const [handedness, setHandedness] = useState<HandednessMap>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/lineup", { cache: "no-store" });
        if (!r.ok) return;
        const json = (await r.json()) as {
          handedness?: Record<string, { bat?: unknown }>;
        };
        if (cancelled || !json.handedness) return;
        const map: HandednessMap = {};
        for (const [k, v] of Object.entries(json.handedness)) {
          const bat = v?.bat;
          if (bat === "L" || bat === "R") map[k] = bat;
        }
        setHandedness(map);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Decorate every AB once with situational context (outs, bases, frame,
  // big-inning, walk-off, spray side relative to handedness). Used by both
  // the chip-highlight system and the hover tooltip.
  const atbats = useMemo<DecoratedAtBat[]>(
    () => decorateAtBats(snapshot?.at_bats ?? [], handedness),
    [snapshot, handedness],
  );

  const [mode, setMode] = useState<Mode>("career");
  const [player, setPlayer] = useState<string>("");
  const [season, setSeason] = useState<number | null>(null);
  const [speed, setSpeed] = useState(0.25);
  const [preset, setPreset] = useState<Preset>("all");
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [showTrails, setShowTrails] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [showRunners, setShowRunners] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progressText, setProgressText] = useState("Idle");
  // Position in the current sequence — drives the scrubber + visible "X of Y"
  // counter. Mirrors `idxRef.current` for any code path that needs to render.
  const [position, setPosition] = useState(0);
  const [seqLen, setSeqLen] = useState(0);
  const [nowCard, setNowCard] = useState<React.ReactNode>(
    <em className="text-stone-500">Press Play to start.</em>,
  );

  const activeLayerRef = useRef<SVGGElement | null>(null);
  const trailLayerRef = useRef<SVGGElement | null>(null);
  // Persistent layer for runner squares that survive across at-bats within
  // the same half-inning. Wiped on inning change, filter change, or reset.
  const baseLayerRef = useRef<SVGGElement | null>(null);
  const runnersRef = useRef<Map<string, RunnerSquare>>(new Map());
  const lastHalfInningRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const idxRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedRef = useRef(speed);
  const showTrailsRef = useRef(showTrails);
  const showLabelsRef = useRef(showLabels);
  const showRunnersRef = useRef(showRunners);
  const modeRef = useRef(mode);
  // Mirrors the most recently rendered sequence so the SVG-level pointer
  // listener can resolve `data-abi="<i>"` back to the AB without paying
  // for a fresh getSequence() filter on every mousemove.
  const seqRef = useRef<DecoratedAtBat[]>([]);
  // Tooltip state — `hoveredAb` swaps content (cheap, infrequent), and the
  // div's left/top is mutated imperatively per pointer event so we don't
  // re-render on every mousemove.
  const [hoveredAb, setHoveredAb] = useState<DecoratedAtBat | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const svgWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);
  useEffect(() => {
    showTrailsRef.current = showTrails;
  }, [showTrails]);
  useEffect(() => {
    showLabelsRef.current = showLabels;
  }, [showLabels]);
  useEffect(() => {
    showRunnersRef.current = showRunners;
    // When the user toggles runners off, sweep the diamond clean immediately
    // — don't wait for the next AB to enforce it.
    if (!showRunners) {
      for (const r of runnersRef.current.values()) killRunner(r);
      runnersRef.current.clear();
    }
  }, [showRunners]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Build dropdown options
  const playerOptions = useMemo(() => {
    const counts: Record<string, { display_name: string; n: number }> = {};
    for (const ab of atbats) {
      if (!ab.person_key) continue;
      if (!counts[ab.person_key]) {
        counts[ab.person_key] = {
          display_name: ab.batter || ab.person_key,
          n: 0,
        };
      }
      counts[ab.person_key].n++;
    }
    return Object.keys(counts)
      .sort((a, b) => counts[b].n - counts[a].n)
      .map((k) => ({ key: k, label: `${counts[k].display_name} (${counts[k].n})` }));
  }, [atbats]);

  const seasonOptions = useMemo(() => {
    const s = new Set<number>();
    for (const ab of atbats) s.add(ab.season_year);
    return [...s].sort();
  }, [atbats]);

  // Initialize selections once data arrives
  useEffect(() => {
    if (!snapshot) return;
    if (!player && playerOptions.length > 0) setPlayer(playerOptions[0].key);
    if (season == null && seasonOptions.length > 0) {
      setSeason(seasonOptions[seasonOptions.length - 1]);
    }
  }, [snapshot, player, season, playerOptions, seasonOptions]);

  const getSequence = useCallback((): DecoratedAtBat[] => {
    let seq: DecoratedAtBat[];
    if (mode === "career") {
      seq = atbats.filter((ab) => ab.person_key === player);
    } else if (mode === "season") {
      seq = atbats.filter((ab) => ab.season_year === season);
    } else {
      seq = atbats.slice();
    }
    seq = seq.filter((ab) => passesFilters(ab, filters));
    seq.sort(
      (a, b) =>
        (a.date || "").localeCompare(b.date || "") ||
        a.transaction_seq - b.transaction_seq,
    );
    return seq;
  }, [atbats, mode, player, season, filters]);

  const clearLayers = useCallback(() => {
    if (activeLayerRef.current) activeLayerRef.current.innerHTML = "";
    if (trailLayerRef.current) trailLayerRef.current.innerHTML = "";
    if (baseLayerRef.current) baseLayerRef.current.innerHTML = "";
    runnersRef.current.clear();
    lastHalfInningRef.current = null;
  }, []);

  const pause = useCallback(() => {
    playingRef.current = false;
    setIsPlaying(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const labelFor = useCallback((ab: AtBat): string => {
    if (modeRef.current === "career" && ab.date) {
      const d = new Date(ab.date + "T00:00:00");
      return d.toLocaleString("en-US", { month: "short", year: "numeric" });
    }
    return ab.batter || "";
  }, []);

  const animateOne = useCallback(
    (ab: DecoratedAtBat, isLastOfHalfInning = false, abi?: number) => {
      const active = activeLayerRef.current;
      const trail = trailLayerRef.current;
      const baseLayer = baseLayerRef.current;
      if (!active || !trail || !baseLayer || ab.x == null || ab.y == null) return;
      const speedSec = speedRef.current;
      const traceDur = Math.min(speedSec * 0.6, 0.6);
      const fadeDur = Math.max(speedSec * 1.2, 0.6);
      const moveDur = Math.max(speedSec * 0.9, 0.45); // runners take a beat longer than the ball
      const c = colorFor(ab.result || undefined);

      // ── PERSISTENT BASE STATE ────────────────────────────────────────────
      // Two reconciliation paths depending on whether we just crossed a
      // half-inning boundary:
      //
      //  (a) NEW HALF-INNING (`half_inning_id` differs from the last AB we
      //      animated): hard-wipe every runner from the DOM + map and DO NOT
      //      seed from `runners_before`. Slo-pitch innings always start with
      //      zero runners, so this is physically correct. We deliberately
      //      ignore `runners_before` at inning boundaries because the
      //      Phase 3 motion walker bleeds stale state across ~19% of inning
      //      starts (245 of 1294 in current snapshot) — trusting it would
      //      "stick" runners that aren't actually there. The next AB's
      //      `runner_moves` will conjure any genuine mid-play state via the
      //      data-gap recovery branch below.
      //
      //  (b) SAME HALF-INNING (or first AB of session): standard
      //      reconciliation against `runners_before` — remove anyone not
      //      expected, seed anyone we're missing. Preserves continuity
      //      across consecutive ABs in the same frame.
      const inningId = ab.half_inning_id ?? null;
      const before = ab.runners_before ?? null;
      const prevInning = lastHalfInningRef.current;
      const inningChanged = prevInning !== null && inningId !== prevInning;

      if (inningChanged) {
        // Hard cut — synchronous teardown. `killRunner` bumps each
        // runner's genId so any pending tween/fade aborts on its next
        // frame (no more in-flight animations writing to detached DOM).
        for (const r of runnersRef.current.values()) killRunner(r);
        runnersRef.current.clear();
      } else if (showRunnersRef.current) {
        const expectedKeys = new Set<string>();
        const expectedByBase: { 1?: string; 2?: string; 3?: string } = {};
        if (before) {
          for (const b of [1, 2, 3] as const) {
            const nm = before[String(b) as "1" | "2" | "3"];
            if (nm) {
              const key = runnerKey(nm);
              expectedKeys.add(key);
              expectedByBase[b] = nm;
            }
          }
        }
        // 1. Remove any displayed runner not expected here.
        for (const [key, r] of [...runnersRef.current.entries()]) {
          if (!expectedKeys.has(key)) {
            killRunner(r);
            runnersRef.current.delete(key);
          }
        }
        // 2. Seed (or relocate) every expected runner. If they're already
        //    on the diamond at the wrong base — typical drift after a
        //    fast-playback tween got cancelled mid-flight — snap them to
        //    the expected base instead of trusting the stale position.
        for (const b of [1, 2, 3] as const) {
          const nm = expectedByBase[b];
          if (!nm) continue;
          const key = runnerKey(nm);
          const existing = runnersRef.current.get(key);
          if (!existing) {
            const sq = createRunnerSquare(baseLayer, nm, b);
            runnersRef.current.set(key, sq);
          } else if (existing.base !== b) {
            snapRunnerTo(existing, b);
          }
        }
      } else {
        // showRunners is off — make sure nothing lingers from a previous
        // toggle-on session.
        for (const r of runnersRef.current.values()) killRunner(r);
        runnersRef.current.clear();
      }
      lastHalfInningRef.current = inningId;

      // ── BALL ANIMATION (unchanged) ───────────────────────────────────────
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", "160");
      line.setAttribute("y1", "320");
      line.setAttribute("x2", "160");
      line.setAttribute("y2", "320");
      line.setAttribute("stroke", c);
      line.setAttribute("stroke-width", "2");
      line.setAttribute("opacity", "0.85");
      active.appendChild(line);
      const ball = document.createElementNS(SVG_NS, "circle");
      ball.setAttribute("cx", "160");
      ball.setAttribute("cy", "320");
      ball.setAttribute("r", "6");
      ball.setAttribute("fill", c);
      ball.setAttribute("opacity", "0.95");
      active.appendChild(ball);
      const startTime = performance.now();
      function frame(now: number) {
        const t = Math.min(1, (now - startTime) / (traceDur * 1000));
        const ease = 1 - Math.pow(1 - t, 2);
        const x = 160 + ((ab.x as number) - 160) * ease;
        const y = 320 + ((ab.y as number) - 320) * ease;
        line.setAttribute("x2", String(x));
        line.setAttribute("y2", String(y));
        ball.setAttribute("cx", String(x));
        ball.setAttribute("cy", String(y));
        if (t < 1) {
          requestAnimationFrame(frame);
          return;
        }
        if (showTrailsRef.current) {
          const m = paintMarker(trail!, ab, showLabelsRef.current, labelFor(ab), true, abi);
          if (m?.dot) fadeMarker(m.dot, fadeDur * 1000, 0.18, 3);
          if (m?.lbl) fadeMarker(m.lbl, fadeDur * 1000, 0.4);
        } else if (showLabelsRef.current) {
          const m = paintMarker(trail!, ab, true, labelFor(ab), true, abi);
          if (m?.lbl) fadeMarker(m.lbl, fadeDur * 1000, 0.4);
          if (m?.dot) m.dot.remove();
        }
        fadeMarker(ball, 250, 0);
        fadeMarker(line, 350, 0);
        // ── RUNNER MOTION ──────────────────────────────────────────────────
        // Two paths depending on playback speed:
        //   * Slow (≥ TWEEN_MIN_SPEED s/play): tween every move smoothly
        //     through the basepaths. Cancellation via genId means a new
        //     AB cleanly retires any pending tween for the same runner.
        //   * Fast: snap directly to the destination. The tween wouldn't
        //     finish before the next AB anyway, and snapping guarantees
        //     no stranded mid-base squares.
        // Idempotent map deletes (`if (map.get(key) === r) map.delete(...)`)
        // make the post-tween cleanup safe if the same key was rebound to
        // a different runner object during a half-inning hard-wipe.
        const moveMs = moveDur * 1000;
        if (showRunnersRef.current) {
          const moves = (ab.runner_moves ?? []) as RunnerMove[];
          const useSnap = speedSec < TWEEN_MIN_SPEED;
          for (const mv of moves) {
            const key = runnerKey(mv.name);
            const map = runnersRef.current;
            const safeDelete = (r: RunnerSquare) => {
              if (map.get(key) === r) map.delete(key);
            };

            if (useSnap) {
              // ── SNAP MODE ──
              let r = map.get(key);
              if (mv.from === 0) {
                // Brand new batter — replace any prior runner with same key.
                if (r) killRunner(r);
                r = createRunnerSquare(baseLayer!, mv.name, 0);
                map.set(key, r);
              } else if (!r) {
                r = createRunnerSquare(baseLayer!, mv.name, mv.from);
                map.set(key, r);
              }
              if (mv.to === "out" || mv.to === 4) {
                killRunner(r);
                safeDelete(r);
              } else {
                snapRunnerTo(r, mv.to);
              }
              continue;
            }

            // ── TWEEN MODE ──
            if (mv.from === 0) {
              const r = createRunnerSquare(baseLayer!, mv.name, 0);
              const prev = map.get(key);
              if (prev) killRunner(prev);
              map.set(key, r);
              if (mv.to === "out") {
                void tweenRunnerToDugout(r, 320).then(() => safeDelete(r));
              } else {
                void tweenRunner(r, 0, mv.to, moveMs).then(() => {
                  if (mv.to === 4) {
                    void fadeAndRemoveRunner(r, 280).then(() => safeDelete(r));
                  } else {
                    r.base = mv.to as 1 | 2 | 3;
                  }
                });
              }
              continue;
            }
            let r = map.get(key);
            if (!r) {
              r = createRunnerSquare(baseLayer!, mv.name, mv.from);
              map.set(key, r);
            }
            const runner = r;
            if (mv.to === "out") {
              void tweenRunnerToDugout(runner, 320).then(() => safeDelete(runner));
            } else {
              void tweenRunner(runner, mv.from, mv.to, moveMs).then(() => {
                if (mv.to === 4) {
                  void fadeAndRemoveRunner(runner, 280).then(() => safeDelete(runner));
                } else {
                  runner.base = mv.to as 1 | 2 | 3;
                }
              });
            }
          }
        }
        // Run-scoring flash fires alongside the runner motion so the crossing
        // of home reads as a beat in the visual. Hidden when the user opts
        // out of baserunner display — same toggle covers both.
        if (showRunnersRef.current && ab.run_scoring && ab.runs_scored > 0) {
          setTimeout(() => flashHome(active!, ab.runs_scored), moveMs * 0.7);
        }
        // If this is the last at-bat of its half-inning (3 outs / end of
        // inning) AND we're at the end of the sequence, clear the basepaths
        // after the runner motion settles. For mid-sequence inning ends the
        // next AB's reconciliation will handle it; we only need the explicit
        // clear when there IS no next AB.
        if (isLastOfHalfInning) {
          const clearAt = moveMs + 300;
          const scheduledInning = inningId;
          setTimeout(() => {
            // Guard against the race where the next AB already started a
            // new half-inning and seeded fresh runners — only wipe if we're
            // still in the same half-inning we scheduled this for.
            if (lastHalfInningRef.current === scheduledInning) {
              void clearAllRunners(runnersRef.current, 350);
              lastHalfInningRef.current = null;
            }
          }, clearAt);
        }
        setTimeout(() => {
          ball.remove();
          line.remove();
        }, 600);
      }
      requestAnimationFrame(frame);
    },
    [labelFor],
  );

  const renderShowAll = useCallback(
    (seq: DecoratedAtBat[]) => {
      const trail = trailLayerRef.current;
      if (!trail) return;
      const frag = document.createDocumentFragment();
      const showT = showTrailsRef.current;
      const showL = showLabelsRef.current;
      for (let i = 0; i < seq.length; i++) {
        const ab = seq[i];
        if (ab.x == null || ab.y == null) continue;
        const c = colorFor(ab.result || undefined);
        if (showT) {
          const dot = document.createElementNS(SVG_NS, "circle");
          dot.setAttribute("cx", String(ab.x));
          dot.setAttribute("cy", String(ab.y));
          dot.setAttribute("r", "3");
          dot.setAttribute("fill", c);
          dot.setAttribute("opacity", "0.18");
          stampMetadata(dot, ab, i);
          frag.appendChild(dot);
        }
        if (showL) {
          const lbl = document.createElementNS(SVG_NS, "text");
          lbl.setAttribute("x", String(ab.x + 6));
          lbl.setAttribute("y", String(ab.y));
          lbl.setAttribute("fill", "#1f2937");
          lbl.setAttribute("font-size", "9");
          lbl.setAttribute("opacity", "0.4");
          stampMetadata(lbl, ab, i);
          lbl.textContent = labelFor(ab);
          frag.appendChild(lbl);
        }
      }
      trail.appendChild(frag);
    },
    [labelFor],
  );

  // Reset playback whenever inputs change
  useEffect(() => {
    pause();
    idxRef.current = 0;
    clearLayers();
    const seq = getSequence();
    seqRef.current = seq;
    setSeqLen(seq.length);
    if (seq.length === 0) {
      setPosition(0);
      setProgressText("0 at-bats queued");
      setNowCard(
        <em className="text-stone-500">No at-bats match the current filters.</em>,
      );
      return;
    }
    renderShowAll(seq);
    idxRef.current = seq.length;
    setPosition(seq.length);
    setProgressText(`${seq.length} / ${seq.length} (all rendered)`);
    setNowCard(
      <em className="text-stone-500">
        {seq.length} at-bats shown. Hover the chips below to highlight, or press Play to animate.
      </em>,
    );
  }, [getSequence, clearLayers, pause, renderShowAll, showTrails, showLabels]);

  const step = useCallback(() => {
    if (!playingRef.current) return;
    const seq = getSequence();
    if (idxRef.current >= seq.length) {
      playingRef.current = false;
      setIsPlaying(false);
      setNowCard(<em>Finished. {seq.length} at-bats played.</em>);
      return;
    }
    const ab = seq[idxRef.current];
    // Is this the last AB of its half-inning? Either there's no next AB, or
    // the next AB is from a different half-inning (i.e. the inning ended,
    // typically because of 3 outs).
    const nextAb = seq[idxRef.current + 1];
    const isLastOfHalfInning =
      !nextAb ||
      (ab.half_inning_id != null && nextAb.half_inning_id !== ab.half_inning_id);
    animateOne(ab, isLastOfHalfInning, idxRef.current);
    setNowCard(
      <div>
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ background: colorFor(ab.result || undefined) }}
          />
          <b>{ab.batter}</b>
          <span className="text-stone-500">vs</span>
          <span>{ab.opponent}</span>
          <span className="rounded-full bg-stone-100 px-2 text-xs">{ab.season_year}</span>
        </div>
        <div className="mt-1 text-sm text-stone-600">
          {ab.result || "?"} · {ab.play_type || ""} · fielded by {ab.defender_position || "?"}
        </div>
        <div className="text-xs text-stone-500">{ab.date}</div>
      </div>,
    );
    setProgressText(`${idxRef.current + 1} / ${seq.length} (${ab.date})`);
    idxRef.current++;
    setPosition(idxRef.current);
    const speedMs = speedRef.current * 1000;
    timerRef.current = setTimeout(step, speedMs);
  }, [animateOne, getSequence]);

  const play = useCallback(() => {
    if (playingRef.current) return;
    const seq = getSequence();
    if (idxRef.current >= seq.length) {
      idxRef.current = 0;
      setPosition(0);
      clearLayers();
    }
    playingRef.current = true;
    setIsPlaying(true);
    step();
  }, [clearLayers, getSequence, step]);

  const restart = useCallback(() => {
    pause();
    idxRef.current = 0;
    setPosition(0);
    clearLayers();
    play();
  }, [clearLayers, pause, play]);

  const showAll = useCallback(() => {
    pause();
    clearLayers();
    const seq = getSequence();
    renderShowAll(seq);
    idxRef.current = seq.length;
    setPosition(seq.length);
    setNowCard(
      <em className="text-stone-500">
        Showing all {seq.length} at-bats. Hover the chips to highlight subsets.
      </em>,
    );
    setProgressText(`${seq.length} / ${seq.length} (all rendered)`);
  }, [clearLayers, getSequence, pause, renderShowAll]);

  // Jump to any point in the sequence. Trails for already-played ABs are
  // re-rendered so the diamond reflects "we just played up to here", and
  // playback resumes from `target` if the user presses Play.
  const seekTo = useCallback(
    (target: number) => {
      pause();
      const seq = getSequence();
      const t = Math.max(0, Math.min(seq.length, Math.floor(target)));
      clearLayers();
      if (t > 0) renderShowAll(seq.slice(0, t));
      idxRef.current = t;
      setPosition(t);
      if (seq.length === 0) {
        setProgressText("0 at-bats queued");
        return;
      }
      if (t >= seq.length) {
        setProgressText(`${seq.length} / ${seq.length} (end)`);
        setNowCard(<em className="text-stone-500">End of sequence.</em>);
      } else {
        const ab = seq[t];
        setProgressText(`${t} / ${seq.length} (${ab.date})`);
        setNowCard(
          <div className="text-sm text-stone-600">
            <div>
              Up next: <b className="text-stone-900">{ab.batter}</b>
              {ab.opponent ? <span className="text-stone-500"> vs {ab.opponent}</span> : null}
            </div>
            <div className="text-xs text-stone-500">{ab.date}</div>
          </div>,
        );
      }
    },
    [clearLayers, getSequence, pause, renderShowAll],
  );

  // Highlight chips
  const highlightChips = useMemo(() => {
    const seasons = [...new Set(atbats.map((a) => a.season_year))].sort();
    return [
      {
        label: "Season",
        chips: seasons.map((y) => ({ text: String(y), attr: "season", val: String(y) })),
      },
      {
        label: "Hit",
        chips: [
          { text: "1B", attr: "result", val: "single" },
          { text: "2B", attr: "result", val: "double" },
          { text: "3B", attr: "result", val: "triple" },
          { text: "HR", attr: "result", val: "home_run" },
        ],
      },
      {
        label: "Outcome",
        chips: [
          { text: "RBI events", attr: "rs", val: "true" },
          { text: "SF", attr: "result", val: "sacrifice_fly" },
          { text: "ROE", attr: "result", val: "error" },
          { text: "FC", attr: "result", val: "fielders_choice" },
        ],
      },
      {
        label: "Zone",
        chips: [
          { text: "Outfield", attr: "zone", val: "outfield" },
          { text: "Infield", attr: "zone", val: "infield" },
          { text: "Left", attr: "side", val: "left" },
          { text: "Middle", attr: "side", val: "middle" },
          { text: "Right", attr: "side", val: "right" },
        ],
      },
      {
        label: "Contact",
        chips: [
          { text: "Line drive", attr: "pt", val: "line_drive" },
          { text: "Fly ball", attr: "pt", val: "fly_ball" },
          { text: "Grounder", attr: "pt", val: "ground_ball" },
          { text: "Hard GB", attr: "pt", val: "hard_ground_ball" },
          { text: "Pop fly", attr: "pt", val: "pop_fly" },
        ],
      },
      {
        label: "Situation",
        chips: [
          { text: "Leadoff", attr: "leadoff", val: "true" },
          { text: "0 outs", attr: "outs", val: "0" },
          { text: "1 out", attr: "outs", val: "1" },
          { text: "2 outs", attr: "outs", val: "2" },
          { text: "RISP", attr: "risp", val: "true" },
          { text: "Bases loaded", attr: "loaded", val: "true" },
          { text: "1st inning", attr: "frame", val: "1" },
          { text: "Late (5+)", attr: "lateinn", val: "true" },
        ],
      },
      {
        label: "Impact",
        chips: [
          { text: "1 RBI", attr: "rbi", val: "single" },
          { text: "2+ RBI", attr: "rbi", val: "multi" },
          { text: "Walk-off", attr: "walkoff", val: "true" },
          { text: "Big inning (5+)", attr: "biginn", val: "true" },
          { text: "Productive out", attr: "prodout", val: "true" },
        ],
      },
      {
        label: "Spray (vs hand)",
        chips: [
          { text: "Pulled", attr: "spray", val: "pull" },
          { text: "Pushed (oppo)", attr: "spray", val: "push" },
          { text: "Up the middle", attr: "spray", val: "middle" },
        ],
      },
    ];
  }, [atbats]);

  const onChipEnter = useCallback((attr: string, val: string) => {
    const trail = trailLayerRef.current;
    if (!trail) return;
    trail.querySelectorAll("circle, text").forEach((el) => {
      const m = (el as SVGElement).getAttribute("data-" + attr) === val;
      if (el.tagName === "circle") {
        el.setAttribute("opacity", m ? "0.95" : "0.04");
        el.setAttribute("r", m ? "5" : "2.5");
      } else {
        el.setAttribute("opacity", m ? "0.9" : "0.04");
      }
    });
  }, []);

  const onChipLeave = useCallback(() => {
    const trail = trailLayerRef.current;
    if (!trail) return;
    trail.querySelectorAll("circle, text").forEach((el) => {
      if (el.tagName === "circle") {
        el.setAttribute("opacity", "0.18");
        el.setAttribute("r", "3");
      } else {
        el.setAttribute("opacity", "0.4");
      }
    });
  }, []);

  // Position the tooltip imperatively (no React re-render per mousemove).
  const placeTooltip = useCallback((clientX: number, clientY: number) => {
    const tip = tooltipRef.current;
    const wrap = svgWrapRef.current;
    if (!tip || !wrap) return;
    const wrapRect = wrap.getBoundingClientRect();
    const x = clientX - wrapRect.left + 14;
    const y = clientY - wrapRect.top + 14;
    // Clamp inside wrapper so it never overflows on the right or bottom.
    const tipW = tip.offsetWidth || 220;
    const tipH = tip.offsetHeight || 80;
    const maxX = wrapRect.width - tipW - 4;
    const maxY = wrapRect.height - tipH - 4;
    tip.style.transform = `translate(${Math.max(0, Math.min(x, maxX))}px, ${Math.max(0, Math.min(y, maxY))}px)`;
  }, []);

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const t = e.target as SVGElement;
      if (
        (t.tagName === "circle" || t.tagName === "text") &&
        t.hasAttribute("data-abi")
      ) {
        const i = parseInt(t.getAttribute("data-abi") || "", 10);
        const ab = Number.isFinite(i) ? seqRef.current[i] : null;
        if (ab) {
          if (hoveredAb !== ab) setHoveredAb(ab);
          placeTooltip(e.clientX, e.clientY);
          return;
        }
      }
      if (hoveredAb) setHoveredAb(null);
    },
    [hoveredAb, placeTooltip],
  );

  const onSvgPointerLeave = useCallback(() => {
    if (hoveredAb) setHoveredAb(null);
  }, [hoveredAb]);

  // Filter toggle helpers
  function togglePresetTo(p: Preset) {
    setPreset(p);
    setFilters(applyPreset(p));
  }
  function toggleSetMember(
    group: keyof Pick<Filters, "result" | "playType" | "zone" | "side">,
    value: string,
  ) {
    setPreset("all");
    setFilters((prev) => {
      const next = { ...prev, [group]: new Set(prev[group]) } as Filters;
      const s = next[group] as Set<string>;
      if (s.has(value)) s.delete(value);
      else s.add(value);
      return next;
    });
  }

  if (error) return <p className="text-red-700">Failed to load data: {error.message}</p>;
  if (!snapshot) return <p className="text-stone-500">Loading…</p>;

  return (
    <div className="grid gap-4 md:grid-cols-[300px_1fr]">
      {/* Controls */}
      <aside className="space-y-3 rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Mode
          </h2>
          <div className="space-y-1 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="dmode"
                checked={mode === "career"}
                onChange={() => setMode("career")}
              />
              Career playback (one player)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="dmode"
                checked={mode === "season"}
                onChange={() => setMode("season")}
              />
              Season playback (everyone)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="dmode"
                checked={mode === "all"}
                onChange={() => setMode("all")}
              />
              All seasons (everything)
            </label>
          </div>
        </div>

        {mode === "career" && (
          <div>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
              Player
            </h2>
            <select
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
              className="min-h-11 w-full rounded-md border border-stone-300 px-2 py-2 text-sm"
            >
              {playerOptions.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {mode === "season" && (
          <div>
            <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
              Season
            </h2>
            <select
              value={season ?? ""}
              onChange={(e) => setSeason(+e.target.value)}
              className="min-h-11 w-full rounded-md border border-stone-300 px-2 py-2 text-sm"
            >
              {seasonOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        )}

        {mode === "all" && (
          <p className="text-xs text-stone-500">
            Plays every Bumblebees at-bat ever tracked (2018–2025), chronologically. Recommend
            speed ≤ 0.05 s/play.
          </p>
        )}

        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Playback
          </h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={play}
              disabled={isPlaying}
              className="min-h-11 rounded-md bg-amber-700 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
            >
              ▶ Play
            </button>
            <button
              type="button"
              onClick={pause}
              className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm hover:bg-stone-100"
            >
              ⏸ Pause
            </button>
            <button
              type="button"
              onClick={showAll}
              className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm hover:bg-stone-100"
            >
              ⤓ Show all
            </button>
            <button
              type="button"
              onClick={restart}
              className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm hover:bg-stone-100"
            >
              ⏮ Restart
            </button>
          </div>
          <div className="mt-2 text-xs text-stone-500">
            Speed: <span className="tabular-nums">{speed.toFixed(2)}</span> s/play
          </div>
          <input
            type="range"
            min={0.01}
            max={2}
            step={0.01}
            value={speed}
            onChange={(e) => {
              const v = +e.target.value;
              setSpeed(v);
              if (playingRef.current) {
                pause();
                setTimeout(play, 30);
              }
            }}
            className="w-full accent-amber-700"
          />
          <div className="mt-3 flex items-center justify-between text-xs text-stone-500">
            <span>Position</span>
            <span className="tabular-nums">
              {position} / {seqLen}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(seqLen, 1)}
            step={1}
            value={Math.min(position, seqLen)}
            disabled={seqLen === 0}
            onChange={(e) => seekTo(+e.target.value)}
            className="w-full accent-amber-700 disabled:opacity-50"
            aria-label="Jump to at-bat"
          />
        </div>

        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Quick filter
          </h2>
          <select
            value={preset}
            onChange={(e) => togglePresetTo(e.target.value as Preset)}
            className="min-h-11 w-full rounded-md border border-stone-300 px-2 py-2 text-sm"
          >
            <option value="all">All at-bats</option>
            <option value="hits">All hits</option>
            <option value="xbh">Extra-base hits only (2B/3B/HR)</option>
            <option value="hr">Home runs only</option>
            <option value="runs">Run-scoring events</option>
            <option value="of_hits">Hits to outfield only</option>
            <option value="if_hits">Hits to infield only</option>
            <option value="outs">Outs only</option>
            <option value="line_drives">Line drives only</option>
            <option value="ground_balls">Ground balls only</option>
            <option value="left">Pulled left / left-side</option>
            <option value="right">Pulled right / right-side</option>
            <option value="middle">Up the middle</option>
          </select>
        </div>

        <details open={showAdvanced} onToggle={(e) => setShowAdvanced(e.currentTarget.open)}>
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-stone-500">
            Advanced filters
          </summary>
          <div className="mt-2 space-y-3 text-sm">
            <FilterCheckGroup
              title="Result type"
              options={[
                ["single", "Single (1B)"],
                ["double", "Double (2B)"],
                ["triple", "Triple (3B)"],
                ["home_run", "Home run"],
                ["outs", "Outs (any)"],
                ["sacrifice_fly", "Sac fly"],
                ["fielders_choice", "Fielder's choice"],
                ["error", "Reached on error"],
              ]}
              checked={filters.result}
              onToggle={(v) => toggleSetMember("result", v)}
            />
            <FilterCheckGroup
              title="Play type"
              options={[
                ["line_drive", "Line drive"],
                ["fly_ball", "Fly ball"],
                ["ground_ball", "Ground ball"],
                ["pop_fly", "Pop fly"],
                ["bunt", "Bunt / other"],
              ]}
              checked={filters.playType}
              onToggle={(v) => toggleSetMember("playType", v)}
            />
            <FilterCheckGroup
              title="Field zone"
              options={[
                ["infield", "Infield"],
                ["outfield", "Outfield"],
              ]}
              checked={filters.zone}
              onToggle={(v) => toggleSetMember("zone", v)}
            />
            <FilterCheckGroup
              title="Field side"
              options={[
                ["left", "Left side"],
                ["middle", "Middle"],
                ["right", "Right side"],
              ]}
              checked={filters.side}
              onToggle={(v) => toggleSetMember("side", v)}
            />
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={filters.onlyRuns}
                onChange={(e) => {
                  setPreset("all");
                  setFilters({ ...filters, onlyRuns: e.target.checked });
                }}
              />
              Only run-scoring at-bats
            </label>
          </div>
        </details>

        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Display
          </h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showTrails}
              onChange={(e) => setShowTrails(e.target.checked)}
            />
            Persistent fading markers
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showLabels}
              onChange={(e) => setShowLabels(e.target.checked)}
            />
            Show batter labels
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showRunners}
              onChange={(e) => setShowRunners(e.target.checked)}
            />
            Show baserunners &amp; scores
          </label>
        </div>

        <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm">{nowCard}</div>
      </aside>

      {/* Diamond + chips */}
      <section className="space-y-3">
        <div
          ref={svgWrapRef}
          className="relative aspect-square overflow-hidden rounded-2xl border border-emerald-900/20 bg-emerald-50 p-2 shadow-sm"
        >
          <svg
            viewBox="-110 -110 510 510"
            preserveAspectRatio="xMidYMid meet"
            className="h-full w-full"
            onPointerMove={onSvgPointerMove}
            onPointerLeave={onSvgPointerLeave}
          >
            <defs>
              <radialGradient id="grass" cx="50%" cy="100%" r="100%">
                <stop offset="0%" stopColor="#83c79a" />
                <stop offset="100%" stopColor="#3b8a52" />
              </radialGradient>
              <linearGradient id="dirt" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#c89a6d" />
                <stop offset="100%" stopColor="#a07347" />
              </linearGradient>
            </defs>
            <rect x="-110" y="-110" width="510" height="510" fill="#dbe5d8" />
            <path
              d="M 160 320 L -100 60 A 320 320 0 0 1 420 60 L 160 320 Z"
              fill="url(#grass)"
            />
            <path
              d="M -100 60 A 320 320 0 0 1 420 60"
              stroke="#2d6b3f"
              strokeWidth="6"
              fill="none"
            />
            <polygon points="160,320 285,205 160,90 35,205" fill="url(#dirt)" />
            <circle cx="160" cy="220" r="14" fill="#9d6e3c" />
            <circle cx="160" cy="220" r="6" fill="#5d3e1e" />
            <rect x="155" y="315" width="10" height="10" fill="#fff" transform="rotate(45 160 320)" />
            <rect x="280" y="200" width="10" height="10" fill="#fff" transform="rotate(45 285 205)" />
            <rect x="155" y="85" width="10" height="10" fill="#fff" transform="rotate(45 160 90)" />
            <rect x="30" y="200" width="10" height="10" fill="#fff" transform="rotate(45 35 205)" />
            <line x1="160" y1="320" x2="-100" y2="60" stroke="#fff" strokeWidth="1.5" opacity="0.7" />
            <line x1="160" y1="320" x2="420" y2="60" stroke="#fff" strokeWidth="1.5" opacity="0.7" />
            <g fill="#1f3a25" fontSize="11" opacity="0.55">
              <text x="160" y="50" textAnchor="middle">CF</text>
              <text x="30" y="75" textAnchor="middle">LF</text>
              <text x="290" y="75" textAnchor="middle">RF</text>
              <text x="100" y="155" textAnchor="middle">SS</text>
              <text x="220" y="155" textAnchor="middle">2B</text>
              <text x="60" y="220" textAnchor="middle">3B</text>
              <text x="260" y="220" textAnchor="middle">1B</text>
              <text x="160" y="200" textAnchor="middle">P</text>
            </g>
            <g ref={trailLayerRef} />
            <g ref={baseLayerRef} />
            <g ref={activeLayerRef} />
          </svg>
          {hoveredAb && (
            <div
              ref={tooltipRef}
              className="pointer-events-none absolute left-0 top-0 z-30 max-w-[260px] rounded-lg border border-stone-300 bg-white/95 px-2.5 py-2 text-[12px] leading-snug text-stone-900 shadow-lg backdrop-blur"
            >
              <AtBatTooltip ab={hoveredAb} />
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 text-xs text-stone-600">
          {(
            [
              ["single", "1B"],
              ["double", "2B"],
              ["triple", "3B"],
              ["home_run", "HR"],
              ["sacrifice_fly", "SF"],
              ["fielders_choice", "FC"],
              ["error", "ROE"],
              ["batter_out", "Out"],
            ] as const
          ).map(([k, t]) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: RESULT_COLORS[k] }}
              />
              {t}
            </span>
          ))}
        </div>

        <div className="rounded-2xl border border-amber-200 bg-white p-3 shadow-sm">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Hover to highlight matching markers
          </h3>
          <div className="flex flex-wrap gap-2">
            {highlightChips.map((g) => (
              <span
                key={g.label}
                className="inline-flex flex-wrap items-center gap-1 rounded-md border border-stone-200 bg-stone-50 px-2 py-1"
              >
                <span className="text-[10px] uppercase tracking-wide text-stone-500">
                  {g.label}
                </span>
                {g.chips.map((c) => (
                  <button
                    type="button"
                    key={`${c.attr}-${c.val}`}
                    onMouseEnter={() => onChipEnter(c.attr, c.val)}
                    onMouseLeave={onChipLeave}
                    onFocus={() => onChipEnter(c.attr, c.val)}
                    onBlur={onChipLeave}
                    className="rounded-full bg-white px-2 py-1 text-xs hover:bg-amber-100 hover:text-amber-900"
                  >
                    {c.text}
                  </button>
                ))}
              </span>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-amber-200 bg-white px-3 py-2 text-xs text-stone-600 shadow-sm">
          Progress: {progressText}
        </div>
      </section>
    </div>
  );
}

function basesText(d: AtBatDerived, before: BaseSnapshot): string {
  if (d.loaded) return "bases loaded";
  const b1 = !!before["1"];
  const b2 = !!before["2"];
  const b3 = !!before["3"];
  if (!b1 && !b2 && !b3) return "bases empty";
  const parts: string[] = [];
  if (b1) parts.push("1st");
  if (b2) parts.push("2nd");
  if (b3) parts.push("3rd");
  if (parts.length === 1) return `runner on ${parts[0]}`;
  return `runners on ${parts.join(" & ")}`;
}

function tagPills(ab: DecoratedAtBat): { text: string; tone: string }[] {
  const out: { text: string; tone: string }[] = [];
  if (ab.d.walk_off) out.push({ text: "walk-off", tone: "bg-amber-200 text-amber-900" });
  if (ab.d.big_inning) out.push({ text: "big inning", tone: "bg-emerald-100 text-emerald-900" });
  if (ab.d.leadoff) out.push({ text: "leadoff", tone: "bg-sky-100 text-sky-900" });
  if (ab.d.loaded) out.push({ text: "bases loaded", tone: "bg-violet-100 text-violet-900" });
  else if (ab.d.risp) out.push({ text: "RISP", tone: "bg-violet-100 text-violet-900" });
  if (ab.d.productive_out) out.push({ text: "productive out", tone: "bg-stone-200 text-stone-800" });
  if (ab.d.spray !== "middle" && ab.d.spray !== "other") {
    out.push({
      text: ab.d.spray === "pull" ? "pulled" : "oppo",
      tone: "bg-orange-100 text-orange-900",
    });
  }
  return out;
}

function AtBatTooltip({ ab }: { ab: DecoratedAtBat }) {
  const c = colorFor(ab.result || undefined);
  const rbi = ab.runs_scored ?? 0;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />
        <b>{ab.batter || "?"}</b>
        <span className="text-stone-500">vs</span>
        <span>{ab.opponent || "?"}</span>
        <span className="ml-auto rounded-full bg-stone-100 px-1.5 text-[10px] tabular-nums text-stone-600">
          {ab.season_year}
        </span>
      </div>
      <div className="mt-0.5 text-stone-700">
        <b className="text-stone-900">{ab.result || "?"}</b>
        {ab.play_type ? <> · {ab.play_type.replace(/_/g, " ")}</> : null}
        {ab.defender_position ? <> → {ab.defender_position}</> : null}
        {rbi > 0 && (
          <>
            {" · "}
            <b className="text-amber-800">+{rbi} RBI</b>
          </>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-stone-600">
        Frame {ab.d.frame || "?"} · {ab.d.outs_before} out{ab.d.outs_before === 1 ? "" : "s"} ·{" "}
        {basesText(ab.d, ab.runners_before)}
      </div>
      <div className="text-[11px] text-stone-500">{ab.date}</div>
      {tagPills(ab).length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {tagPills(ab).map((p) => (
            <span
              key={p.text}
              className={`rounded-full px-1.5 py-px text-[10px] font-semibold ${p.tone}`}
            >
              {p.text}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function FilterCheckGroup({
  title,
  options,
  checked,
  onToggle,
}: {
  title: string;
  options: readonly (readonly [string, string])[];
  checked: Set<string>;
  onToggle: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
        {title}
      </div>
      <div className="space-y-0.5">
        {options.map(([val, label]) => (
          <label key={val} className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={checked.has(val)}
              onChange={() => onToggle(val)}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}
