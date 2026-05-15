"use client";

import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip,
} from "chart.js";
import { useEffect, useMemo, useState } from "react";
import { Line } from "react-chartjs-2";
import { useSnapshot } from "@/lib/useSnapshot";
import type { Player, PlayerGame } from "@/lib/data";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
);

const COLORS = [
  "#3aaaff",
  "#ffd24a",
  "#ff7a59",
  "#69d68f",
  "#c084fc",
  "#f472b6",
  "#22d3ee",
  "#fbbf24",
  "#a3e635",
  "#fb7185",
  "#60a5fa",
  "#34d399",
];

type Metric = "bmbl" | "wOBA" | "pa" | "hits";
type Granularity = "season" | "game5" | "game";

function rollingAvg(
  games: PlayerGame[],
  window: number,
  key: keyof PlayerGame,
): { x: string; y: number | null }[] {
  const out: { x: string; y: number | null }[] = [];
  for (let i = 0; i < games.length; i++) {
    const slice = games.slice(Math.max(0, i - window + 1), i + 1);
    const vals: number[] = [];
    for (const g of slice) {
      const v = g[key];
      if (typeof v === "number" && !Number.isNaN(v)) vals.push(v);
    }
    out.push({
      x: games[i].date,
      y: vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length,
    });
  }
  return out;
}

export default function Trends() {
  const { snapshot, error } = useSnapshot();
  const [search, setSearch] = useState("");
  const [metric, setMetric] = useState<Metric>("bmbl");
  const [gran, setGran] = useState<Granularity>("season");
  const [ymin, setYmin] = useState<number | null>(null);
  const [ymax, setYmax] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initialized, setInitialized] = useState(false);
  const [archived, setArchived] = useState<Set<string>>(new Set());

  // Pull the archive list from the shared lineup blob so retired players
  // (e.g. someone Greg explicitly archived on /lineup) drop out of Trends
  // too. Best-effort: if /api/lineup fails or storage isn't configured,
  // we just show everyone — the page still works.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/lineup", { cache: "no-store" });
        if (!r.ok) return;
        const json = (await r.json()) as { archived?: unknown };
        if (cancelled) return;
        if (Array.isArray(json.archived)) {
          setArchived(new Set(json.archived.filter((s): s is string => typeof s === "string")));
        }
      } catch {
        // ignore — chart still renders without filter
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const playerKeys = useMemo(() => {
    if (!snapshot) return [];
    return Object.keys(snapshot.players)
      .filter((k) => !archived.has(k))
      .sort((a, b) => {
        const ca = snapshot.career_weighted[a]?.career_BMBLplus_weighted ?? -999;
        const cb = snapshot.career_weighted[b]?.career_BMBLplus_weighted ?? -999;
        return cb - ca;
      });
  }, [snapshot, archived]);

  const years = useMemo(() => {
    if (!snapshot) return [];
    const all = new Set<number>();
    playerKeys.forEach((k) =>
      (snapshot.players[k].seasons || []).forEach((s) => all.add(s.season_year)),
    );
    return [...all].sort();
  }, [snapshot, playerKeys]);

  // Initialize defaults once data arrives
  if (snapshot && !initialized && playerKeys.length > 0) {
    setSelected(new Set(playerKeys.slice(0, 5)));
    setYmin(years[0] ?? null);
    setYmax(years[years.length - 1] ?? null);
    setInitialized(true);
  }

  if (error) {
    return <p className="text-red-700">Failed to load data: {error.message}</p>;
  }
  if (!snapshot || ymin == null || ymax == null) {
    return <p className="text-stone-500">Loading…</p>;
  }

  const players = snapshot.players;
  const careerWeighted = snapshot.career_weighted;

  const filteredPlayerKeys = playerKeys.filter((k) =>
    !search || players[k].display_name.toLowerCase().includes(search.toLowerCase()),
  );

  const sortedSel = [...selected].sort(
    (a, b) => playerKeys.indexOf(a) - playerKeys.indexOf(b),
  );

  // Build datasets
  const lo = ymin;
  const hi = ymax;
  const datasets = sortedSel.map((k, idx) => {
    const p: Player = players[k];
    const color = COLORS[idx % COLORS.length];
    if (gran === "season") {
      const seasons = (p.seasons || [])
        .filter((s) => s.season_year >= lo && s.season_year <= hi)
        .sort((a, b) => a.season_year - b.season_year);
      const points = seasons.map((s) => {
        let y: number | null;
        if (metric === "bmbl") y = s.BMBL_plus;
        else if (metric === "wOBA") y = s.wOBA;
        else if (metric === "pa") y = s.PA;
        else y = null;
        return { x: String(s.season_year), y };
      });
      return {
        label: p.display_name,
        data: points,
        borderColor: color,
        backgroundColor: color,
        tension: 0.2,
        pointRadius: 4,
      };
    }
    const games = (p.games || [])
      .filter((g) => g.season_year >= lo && g.season_year <= hi)
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const window = gran === "game5" ? 5 : 1;
    const key: keyof PlayerGame =
      metric === "wOBA" || metric === "bmbl"
        ? "wOBA_game"
        : metric === "pa"
          ? "PA"
          : "H";
    const points = rollingAvg(games, window, key) as { x: string; y: number | null }[];
    return {
      label: p.display_name,
      data: points,
      borderColor: color,
      backgroundColor: color,
      tension: 0.25,
      pointRadius: window === 1 ? 2 : 0,
    };
  });

  // Unify x-axis (string-keyed across datasets) and back-fill nulls so chartjs spans gaps
  const allX: string[] = [];
  const seen = new Set<string>();
  datasets.forEach((ds) =>
    ds.data.forEach((pt) => {
      if (!seen.has(pt.x)) {
        seen.add(pt.x);
        allX.push(pt.x);
      }
    }),
  );
  allX.sort();
  const finalSets = datasets.map((ds) => {
    const m = new Map(ds.data.map((p) => [p.x, p.y]));
    return {
      ...ds,
      data: allX.map((x) => (m.has(x) ? m.get(x) ?? null : null)),
      spanGaps: true,
    };
  });

  function toggleSelected(k: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }
  function selectTop(n: number) {
    setSelected(new Set(playerKeys.slice(0, n)));
  }
  function clearSelection() {
    setSelected(new Set());
  }

  return (
    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
      <aside className="space-y-3 rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Players ({playerKeys.length})
          </h2>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="mb-2 min-h-11 w-full rounded-md border border-stone-300 px-2 py-2 text-sm"
          />
          <div className="mb-2 flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => selectTop(5)}
              className="rounded-full bg-stone-100 px-3 py-1 text-sm hover:bg-stone-200"
            >
              Top 5
            </button>
            <button
              type="button"
              onClick={() => selectTop(10)}
              className="rounded-full bg-stone-100 px-3 py-1 text-sm hover:bg-stone-200"
            >
              Top 10
            </button>
            <button
              type="button"
              onClick={clearSelection}
              className="rounded-full bg-stone-100 px-3 py-1 text-sm hover:bg-stone-200"
            >
              Clear
            </button>
          </div>
          <div className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
            {filteredPlayerKeys.map((k) => {
              const c = careerWeighted[k];
              const career = c ? c.career_BMBLplus_weighted.toFixed(1) : "—";
              return (
                <label
                  key={k}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-amber-50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(k)}
                    onChange={() => toggleSelected(k)}
                    className="h-4 w-4 accent-amber-600"
                  />
                  <span className="flex-1">{players[k].display_name}</span>
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs tabular-nums text-stone-700">
                    {career}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        <hr className="border-stone-200" />

        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            View
          </h2>
          <div className="flex flex-col gap-2">
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as Metric)}
              className="min-h-11 rounded-md border border-stone-300 px-2 py-2 text-sm"
            >
              <option value="bmbl">BMBL+ (season)</option>
              <option value="wOBA">wOBA</option>
              <option value="pa">PA per game</option>
              <option value="hits">Hits per game</option>
            </select>
            <select
              value={gran}
              onChange={(e) => setGran(e.target.value as Granularity)}
              className="min-h-11 rounded-md border border-stone-300 px-2 py-2 text-sm"
            >
              <option value="season">Season</option>
              <option value="game5">5-game rolling</option>
              <option value="game">Per game</option>
            </select>
          </div>
        </div>

        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Year range
          </h2>
          <div className="flex items-center gap-2">
            <select
              value={ymin}
              onChange={(e) => setYmin(+e.target.value)}
              className="min-h-11 flex-1 rounded-md border border-stone-300 px-2 py-2 text-sm"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <span className="text-stone-500">—</span>
            <select
              value={ymax}
              onChange={(e) => setYmax(+e.target.value)}
              className="min-h-11 flex-1 rounded-md border border-stone-300 px-2 py-2 text-sm"
            >
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="text-xs text-stone-500">
          BMBL+: 100 = team-season average. 1 stddev = 25 points.
          <br />
          Per-game wOBA uses Bayesian shrinkage (k=50 PA) toward season mean.
        </p>
      </aside>

      <section className="space-y-4">
        <div className="h-[520px] rounded-2xl border border-amber-200 bg-white p-3 shadow-sm">
          <Line
            data={{ labels: allX, datasets: finalSets }}
            options={{
              responsive: true,
              maintainAspectRatio: false,
              animation: false,
              interaction: { mode: "nearest", intersect: false },
              plugins: { legend: { position: "top" }, tooltip: { mode: "nearest", intersect: false } },
              scales: {
                x: { type: "category", ticks: { maxTicksLimit: 14, autoSkip: true } },
                y: { beginAtZero: false },
              },
            }}
          />
        </div>

        <div className="rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Selected players — career rollup
          </h2>
          {sortedSel.length === 0 ? (
            <p className="italic text-stone-500">Select players.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b border-stone-200 text-xs uppercase tracking-wide text-stone-500">
                    <th className="px-2 py-2 text-left">Player</th>
                    <th className="px-2 py-2 text-left">Seasons</th>
                    <th className="px-2 py-2 text-right">Career PA</th>
                    <th className="px-2 py-2 text-right">Career BMBL+</th>
                    <th className="px-2 py-2 text-left">Peak year</th>
                    <th className="px-2 py-2 text-right">Peak BMBL+</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSel.map((k) => {
                    const c = careerWeighted[k];
                    const p = players[k];
                    if (!c) {
                      return (
                        <tr key={k} className="border-b border-stone-100">
                          <td className="px-2 py-2">{p.display_name}</td>
                          <td colSpan={5} className="px-2 py-2 italic text-stone-500">
                            no qualified seasons
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={k} className="border-b border-stone-100">
                        <td className="px-2 py-2 font-medium">{c.display_name}</td>
                        <td className="px-2 py-2 text-stone-700">{c.seasons_played}</td>
                        <td className="px-2 py-2 text-right tabular-nums">{c.career_PA}</td>
                        <td className="px-2 py-2 text-right font-semibold tabular-nums">
                          {c.career_BMBLplus_weighted.toFixed(1)}
                        </td>
                        <td className="px-2 py-2 text-stone-700">{c.peak_season_year}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {c.peak_BMBLplus.toFixed(1)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
