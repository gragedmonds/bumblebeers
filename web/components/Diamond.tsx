"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSnapshot } from "@/lib/useSnapshot";
import type { AtBat, RunnerMove } from "@/lib/data";

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

/** One runner currently sitting on the diamond. Lives in the persistent base
 * layer across consecutive at-bats in the same half-inning. */
interface RunnerSquare {
  name: string;
  base: 0 | 1 | 2 | 3; // last known stationary base
  rect: SVGRectElement;
  label: SVGTextElement;
}

const RUNNER_SQUARE_SIZE = 14;
const RUNNER_HALF = RUNNER_SQUARE_SIZE / 2;

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

  return { name, base, rect, label };
}

/** Smoothly tween a runner square to the target base point over `ms`. Resolves
 * when the animation completes. Label offset adapts to the new base. */
function tweenRunner(
  runner: RunnerSquare,
  toBase: 0 | 1 | 2 | 3 | 4,
  ms: number,
): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const fromX = parseFloat(runner.rect.getAttribute("x") || "0") + RUNNER_HALF;
    const fromY = parseFloat(runner.rect.getAttribute("y") || "0") + RUNNER_HALF;
    const target = BASE_POINT[toBase];
    const fromLblY = parseFloat(runner.label.getAttribute("y") || "0");
    const targetLblOffset = toBase === 2 ? -14 : 18;
    const targetLblY = target.y + targetLblOffset;
    function frame(now: number) {
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

/** Fade a runner's rect + label to zero opacity and remove from DOM. */
function fadeAndRemoveRunner(runner: RunnerSquare, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const fromR = parseFloat(runner.rect.getAttribute("opacity") || "1");
    const fromL = parseFloat(runner.label.getAttribute("opacity") || "1");
    function frame(now: number) {
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

function stampMetadata(el: SVGElement, ab: AtBat) {
  setDataset(el, "season", String(ab.season_year));
  setDataset(el, "result", ab.result || "");
  setDataset(el, "pt", ab.play_type || "");
  setDataset(el, "zone", ab.field_zone || "");
  setDataset(el, "side", ab.field_side || "");
  setDataset(el, "rs", ab.run_scoring ? "true" : "false");
  setDataset(el, "person", ab.person_key || "");
}

function paintMarker(
  trail: SVGGElement,
  ab: AtBat,
  showLabel: boolean,
  labelText: string,
  initial = true,
) {
  if (ab.x == null || ab.y == null) return null;
  const c = colorFor(ab.result || undefined);
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", String(ab.x));
  dot.setAttribute("cy", String(ab.y));
  dot.setAttribute("r", initial ? "4" : "3");
  dot.setAttribute("fill", c);
  dot.setAttribute("opacity", initial ? "0.6" : "0.18");
  stampMetadata(dot, ab);
  trail.appendChild(dot);
  if (showLabel) {
    const lbl = document.createElementNS(SVG_NS, "text");
    lbl.setAttribute("x", String(ab.x + 6));
    lbl.setAttribute("y", String(ab.y));
    lbl.setAttribute("fill", "#1f2937");
    lbl.setAttribute("font-size", "9");
    lbl.setAttribute("opacity", initial ? "0.9" : "0.4");
    stampMetadata(lbl, ab);
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
  const atbats = snapshot?.at_bats ?? [];

  const [mode, setMode] = useState<Mode>("career");
  const [player, setPlayer] = useState<string>("");
  const [season, setSeason] = useState<number | null>(null);
  const [speed, setSpeed] = useState(0.25);
  const [preset, setPreset] = useState<Preset>("all");
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [showTrails, setShowTrails] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progressText, setProgressText] = useState("Idle");
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
  const modeRef = useRef(mode);

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

  const getSequence = useCallback((): AtBat[] => {
    let seq: AtBat[];
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
    (ab: AtBat) => {
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
      // If this at-bat is in a new half-inning, fade out any leftover runners
      // and re-seed from the BEFORE snapshot. Same inning: trust internal state
      // and let runner_moves animate the transitions.
      const inningId = ab.half_inning_id ?? null;
      const inningChanged = inningId !== lastHalfInningRef.current;
      if (inningChanged) {
        // Fire-and-forget fade; we don't await it before painting the ball.
        void clearAllRunners(runnersRef.current, 220).then(() => {
          if (ab.runners_before) seedRunnersFromSnapshot(baseLayer, runnersRef.current, ab.runners_before);
        });
        lastHalfInningRef.current = inningId;
      }

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
          const m = paintMarker(trail!, ab, showLabelsRef.current, labelFor(ab), true);
          if (m?.dot) fadeMarker(m.dot, fadeDur * 1000, 0.18, 3);
          if (m?.lbl) fadeMarker(m.lbl, fadeDur * 1000, 0.4);
        } else if (showLabelsRef.current) {
          const m = paintMarker(trail!, ab, true, labelFor(ab), true);
          if (m?.lbl) fadeMarker(m.lbl, fadeDur * 1000, 0.4);
          if (m?.dot) m.dot.remove();
        }
        fadeMarker(ball, 250, 0);
        fadeMarker(line, 350, 0);
        // ── RUNNER MOTION ──────────────────────────────────────────────────
        // Animate every transition in ab.runner_moves. Fire after the ball
        // lands (so the visual reads as "play happens then runners react").
        // For inning-changed at-bats we wait for the seed to land before
        // animating moves; for same-inning we kick off immediately.
        const moves = (ab.runner_moves ?? []) as RunnerMove[];
        const moveMs = moveDur * 1000;
        const kickoff = inningChanged ? 260 : 0;
        setTimeout(() => {
          for (const mv of moves) {
            const key = runnerKey(mv.name);
            const map = runnersRef.current;
            // New batter stepping out of the box (from=0): create a square
            // at home plate, then animate to wherever they ended up.
            if (mv.from === 0) {
              const r = createRunnerSquare(baseLayer!, mv.name, 0);
              map.set(key, r);
              if (mv.to === "out") {
                void fadeAndRemoveRunner(r, 350).then(() => map.delete(key));
              } else {
                void tweenRunner(r, mv.to, moveMs).then(() => {
                  if (mv.to === 4) {
                    // Scored. Pull the square off the field.
                    void fadeAndRemoveRunner(r, 280).then(() => map.delete(key));
                  } else {
                    r.base = mv.to as 1 | 2 | 3;
                  }
                });
              }
              continue;
            }
            // Existing runner advancing. Look them up; if they aren't on the
            // diamond (data gap), conjure a square at their `from` base.
            let r = map.get(key);
            if (!r) {
              r = createRunnerSquare(baseLayer!, mv.name, mv.from);
              map.set(key, r);
            }
            if (mv.to === "out") {
              void fadeAndRemoveRunner(r, 350).then(() => map.delete(key));
            } else {
              void tweenRunner(r, mv.to, moveMs).then(() => {
                if (mv.to === 4) {
                  void fadeAndRemoveRunner(r!, 280).then(() => map.delete(key));
                } else {
                  r!.base = mv.to as 1 | 2 | 3;
                }
              });
            }
          }
        }, kickoff);
        // Run-scoring flash fires alongside the runner motion so the crossing
        // of home reads as a beat in the visual.
        if (ab.run_scoring && ab.runs_scored > 0) {
          setTimeout(() => flashHome(active!, ab.runs_scored), kickoff + moveMs * 0.7);
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
    (seq: AtBat[]) => {
      const trail = trailLayerRef.current;
      if (!trail) return;
      const frag = document.createDocumentFragment();
      const showT = showTrailsRef.current;
      const showL = showLabelsRef.current;
      for (const ab of seq) {
        if (ab.x == null || ab.y == null) continue;
        const c = colorFor(ab.result || undefined);
        if (showT) {
          const dot = document.createElementNS(SVG_NS, "circle");
          dot.setAttribute("cx", String(ab.x));
          dot.setAttribute("cy", String(ab.y));
          dot.setAttribute("r", "3");
          dot.setAttribute("fill", c);
          dot.setAttribute("opacity", "0.18");
          stampMetadata(dot, ab);
          frag.appendChild(dot);
        }
        if (showL) {
          const lbl = document.createElementNS(SVG_NS, "text");
          lbl.setAttribute("x", String(ab.x + 6));
          lbl.setAttribute("y", String(ab.y));
          lbl.setAttribute("fill", "#1f2937");
          lbl.setAttribute("font-size", "9");
          lbl.setAttribute("opacity", "0.4");
          stampMetadata(lbl, ab);
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
    if (seq.length === 0) {
      setProgressText("0 at-bats queued");
      setNowCard(
        <em className="text-stone-500">No at-bats match the current filters.</em>,
      );
      return;
    }
    renderShowAll(seq);
    idxRef.current = seq.length;
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
    animateOne(ab);
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
    const speedMs = speedRef.current * 1000;
    timerRef.current = setTimeout(step, speedMs);
  }, [animateOne, getSequence]);

  const play = useCallback(() => {
    if (playingRef.current) return;
    const seq = getSequence();
    if (idxRef.current >= seq.length) {
      idxRef.current = 0;
      clearLayers();
    }
    playingRef.current = true;
    setIsPlaying(true);
    step();
  }, [clearLayers, getSequence, step]);

  const restart = useCallback(() => {
    pause();
    idxRef.current = 0;
    clearLayers();
    play();
  }, [clearLayers, pause, play]);

  const showAll = useCallback(() => {
    pause();
    clearLayers();
    const seq = getSequence();
    renderShowAll(seq);
    idxRef.current = seq.length;
    setNowCard(
      <em className="text-stone-500">
        Showing all {seq.length} at-bats. Hover the chips to highlight subsets.
      </em>,
    );
    setProgressText(`${seq.length} / ${seq.length} (all rendered)`);
  }, [clearLayers, getSequence, pause, renderShowAll]);

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
        </div>

        <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm">{nowCard}</div>
      </aside>

      {/* Diamond + chips */}
      <section className="space-y-3">
        <div className="aspect-square overflow-hidden rounded-2xl border border-emerald-900/20 bg-emerald-50 p-2 shadow-sm">
          <svg viewBox="-110 -110 510 510" preserveAspectRatio="xMidYMid meet" className="h-full w-full">
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
