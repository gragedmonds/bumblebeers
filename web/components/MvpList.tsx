"use client";

import { useMemo, useState } from "react";
import { useSnapshot } from "@/lib/useSnapshot";
import type { MvpNight, MvpLine } from "@/lib/data";

function formatNightDate(d: string): string {
  const dd = new Date(d + "T00:00:00");
  return dd.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function OtherLine({ p }: { p: MvpLine }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <span className="min-w-24 text-stone-700">{p.display_name}</span>
      <span className="text-stone-500">
        {p.H}-for-{p.AB}
        {p.HR ? `, ${p.HR} HR` : ""}
        {p.runs_scored ? `, ${p.runs_scored}R` : ""}
      </span>
      <span className="ml-auto text-stone-400 tabular-nums">{p.score.toFixed(1)}</span>
    </div>
  );
}

function NightCard({ night }: { night: MvpNight }) {
  const mvp = night.mvp;
  const oppText = night.opponents.length ? night.opponents.join(" / ") : "—";
  const others = night.top.slice(1, 4);

  return (
    <div className="mb-3 rounded-2xl border border-amber-300 bg-gradient-to-br from-amber-50 to-white p-5 shadow-sm">
      <div className="text-sm text-stone-500">
        {formatNightDate(night.date)} · vs {oppText}
      </div>
      <div className="mt-1 flex items-center gap-2 text-2xl font-bold text-amber-700">
        <span className="text-3xl">🍺</span>
        {mvp.display_name}
      </div>
      <div className="mt-2 text-stone-700">{night.justification}</div>
      <div className="mt-3 flex flex-wrap gap-2 text-sm">
        <span className="rounded-md bg-stone-100 px-2 py-1">
          <b>{mvp.H}</b>/{mvp.AB}
        </span>
        <span className="rounded-md bg-stone-100 px-2 py-1">
          <b>{mvp.TB}</b> TB
        </span>
        {mvp.HR ? (
          <span className="rounded-md bg-stone-100 px-2 py-1">
            <b>{mvp.HR}</b> HR
          </span>
        ) : null}
        {mvp.XBH ? (
          <span className="rounded-md bg-stone-100 px-2 py-1">
            <b>{mvp.XBH}</b> XBH
          </span>
        ) : null}
        {mvp.runs_scored ? (
          <span className="rounded-md bg-stone-100 px-2 py-1">
            <b>{mvp.runs_scored}</b> runs
          </span>
        ) : null}
        <span className="rounded-md bg-stone-100 px-2 py-1 text-stone-500">
          score <b className="text-stone-900">{mvp.score.toFixed(1)}</b>
        </span>
      </div>
      {others.length > 0 ? (
        <div className="mt-4 border-t border-stone-200 pt-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Also in contention
          </div>
          {others.map((p) => (
            <OtherLine key={p.person_key} p={p} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function MvpList() {
  const { snapshot, error } = useSnapshot();
  const [seasonFilter, setSeasonFilter] = useState("all");
  const [playerFilter, setPlayerFilter] = useState("all");

  const nights = snapshot?.mvp_nights ?? [];

  const seasons = useMemo(
    () => [...new Set(nights.map((n) => n.season_year))].sort(),
    [nights],
  );

  const playerMap = useMemo(() => {
    const m = new Map<string, string>();
    nights.forEach((n) =>
      n.top.forEach((p) => {
        if (!m.has(p.person_key)) m.set(p.person_key, p.display_name);
      }),
    );
    return m;
  }, [nights]);

  const orderedPlayerKeys = useMemo(
    () =>
      [...playerMap.keys()].sort((a, b) =>
        (playerMap.get(a) ?? "").localeCompare(playerMap.get(b) ?? ""),
      ),
    [playerMap],
  );

  const filtered = useMemo(() => {
    let f = nights;
    if (seasonFilter !== "all") f = f.filter((n) => String(n.season_year) === seasonFilter);
    if (playerFilter !== "all") f = f.filter((n) => n.mvp.person_key === playerFilter);
    return f;
  }, [nights, seasonFilter, playerFilter]);

  const tally = useMemo(() => {
    const t = new Map<string, number>();
    filtered.forEach((n) => t.set(n.mvp.person_key, (t.get(n.mvp.person_key) ?? 0) + 1));
    return [...t.entries()]
      .map(([k, v]) => ({ k, v, name: playerMap.get(k) ?? k }))
      .sort((a, b) => b.v - a.v);
  }, [filtered, playerMap]);

  if (error) {
    return <p className="text-red-700">Failed to load data: {error.message}</p>;
  }
  if (!snapshot) {
    return <p className="text-stone-500">Loading…</p>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-[240px_1fr]">
      <aside className="space-y-4 rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">
            🍺 Tall Can recipient
          </h2>
          <p className="mt-2 text-xs text-stone-500">
            For each game night the player with the highest MVP score gets the Tall Can.
            Justification shows when the race is close.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-stone-600">Season</label>
          <select
            value={seasonFilter}
            onChange={(e) => setSeasonFilter(e.target.value)}
            className="min-h-11 w-full rounded-md border border-stone-300 bg-white px-2 py-2"
          >
            <option value="all">All seasons</option>
            {seasons.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-stone-600">
            Player (career view)
          </label>
          <select
            value={playerFilter}
            onChange={(e) => setPlayerFilter(e.target.value)}
            className="min-h-11 w-full rounded-md border border-stone-300 bg-white px-2 py-2"
          >
            <option value="all">All players</option>
            {orderedPlayerKeys.map((k) => (
              <option key={k} value={k}>
                {playerMap.get(k)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Tall Can tally
          </h3>
          {tally.length === 0 ? (
            <p className="text-sm text-stone-500">—</p>
          ) : (
            <ul className="text-sm">
              {tally.slice(0, 12).map((t) => (
                <li key={t.k} className="flex justify-between py-0.5">
                  <span>{t.name}</span>
                  <span className="font-semibold">{t.v}🍺</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-stone-500">
          MVP score weights: TB ×1.5, runs scored ×1.2, HR ×1.5 bonus, XBH ×0.8 bonus, SF ×0.5,
          outs penalized ×0.4.
        </p>
      </aside>

      <section>
        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-amber-200 bg-white p-6 italic text-stone-500 shadow-sm">
            No nights match the current filter.
          </div>
        ) : (
          filtered.map((n) => <NightCard key={n.date} night={n} />)
        )}
      </section>
    </div>
  );
}
