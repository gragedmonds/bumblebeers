"use client";

// Print-friendly view of both games for a single night. Loads the same
// data as NightPlanner (night state, schedule, snapshot) and renders a
// stripped-down table layout sized for 8.5×11 portrait. Auto-fires the
// browser print dialog once data is loaded so the user lands on the
// "Save as PDF" prompt immediately.

import { useEffect, useMemo, useState } from "react";
import {
  POSITIONS_BY_MODE,
  modeForAttendeeCount,
  positionLabel,
  type LineupMode,
  type Pos,
} from "@/lib/lineup";
import {
  emptyNight,
  type GameLineup,
  type InningLineup,
  type PersistedNight,
} from "@/lib/night";
import type { NightSchedule } from "@/lib/schedule";
import { useSnapshot } from "@/lib/useSnapshot";

const INNINGS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

function formatDateLong(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function posInInning(row: InningLineup, playerKey: string): Pos | null {
  for (const [pos, pk] of Object.entries(row)) {
    if (pk === playerKey) return pos as Pos;
  }
  return null;
}

function resolveOrder(
  attending: string[],
  stored: string[] | undefined,
  nameByKey: Map<string, string>,
): string[] {
  const inSet = new Set(attending);
  const seen = new Set<string>();
  const out: string[] = [];
  if (stored) {
    for (const k of stored) {
      if (inSet.has(k) && !seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  const remaining = attending
    .filter((k) => !seen.has(k))
    .sort((a, b) => (nameByKey.get(a) ?? a).localeCompare(nameByKey.get(b) ?? b));
  out.push(...remaining);
  return out;
}

interface ScheduleResponse {
  nights: NightSchedule[];
}

export default function LineupPrint({ date }: { date: string }) {
  const { snapshot } = useSnapshot();
  const [night, setNight] = useState<PersistedNight>(() => emptyNight(date));
  const [schedule, setSchedule] = useState<NightSchedule | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nightR, schedR] = await Promise.all([
          fetch(`/api/night/${encodeURIComponent(date)}`, { cache: "no-store" }),
          fetch("/api/schedule", { cache: "no-store" }),
        ]);
        const nightJson = (await nightR.json()) as { night?: PersistedNight };
        const schedJson = (await schedR.json()) as ScheduleResponse;
        if (cancelled) return;
        if (nightJson.night) setNight(nightJson.night);
        const match = schedJson.nights?.find((n) => n.date === date) ?? null;
        setSchedule(match);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [date]);

  const nameByKey = useMemo(() => {
    const m = new Map<string, string>();
    if (snapshot) {
      for (const [k, p] of Object.entries(snapshot.players)) {
        m.set(k, p.display_name || k);
      }
    }
    return m;
  }, [snapshot]);

  const attending = useMemo(
    () =>
      Object.entries(night.attendance.status)
        .filter(([, v]) => v === "in")
        .map(([k]) => k),
    [night],
  );

  const mode: LineupMode = useMemo(
    () => modeForAttendeeCount(attending.length),
    [attending.length],
  );

  // Trigger print once data has settled. One-shot — re-printing is via the
  // browser's own print button.
  useEffect(() => {
    if (!loaded || !snapshot) return;
    const t = setTimeout(() => window.print(), 350);
    return () => clearTimeout(t);
  }, [loaded, snapshot]);

  if (!loaded || !snapshot) {
    return <div className="p-6 text-stone-600">Loading lineup…</div>;
  }
  if (err) {
    return <div className="p-6 text-red-700">Failed to load: {err}</div>;
  }

  const games = night.games.length === 2 ? night.games : [emptyGame(), emptyGame()];

  return (
    <div className="mx-auto max-w-[8.5in] bg-white p-4 text-stone-900">
      <header className="mb-4 border-b-2 border-stone-900 pb-2">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold">
            Bumblebeers
            {schedule?.opponent ? (
              <span className="font-normal"> vs {schedule.opponent}</span>
            ) : null}
          </h1>
          <div className="text-right text-sm">
            <div className="font-semibold">{formatDateLong(date)}</div>
            {schedule?.location && (
              <div className="text-xs text-stone-600">@ {schedule.location}</div>
            )}
          </div>
        </div>
        {schedule?.games?.length ? (
          <div className="mt-1 text-xs text-stone-700">
            {schedule.games
              .map((g) => `${g.time} ${g.homeAway === "home" ? "(home)" : "(away)"}`)
              .join("  ·  ")}
            {"  ·  "}
            {mode === "nine"
              ? `9-player mode (one CF) · ${attending.length} attending`
              : `10-player mode · ${attending.length} attending`}
          </div>
        ) : (
          <div className="mt-1 text-xs text-stone-700">
            {mode === "nine"
              ? `9-player mode (one CF) · ${attending.length} attending`
              : `10-player mode · ${attending.length} attending`}
          </div>
        )}
      </header>

      {games.map((g, i) => (
        <PrintableGame
          key={i}
          gameNum={i + 1}
          game={g}
          attending={attending}
          mode={mode}
          nameByKey={nameByKey}
          startTime={schedule?.games?.[i]?.time}
          homeAway={schedule?.games?.[i]?.homeAway}
        />
      ))}

      {/* On-screen reprint hint — hidden in actual print output. */}
      <div className="mt-6 text-xs text-stone-500 print:hidden">
        Use your browser&apos;s Print dialog (or it should have opened automatically). Choose
        &ldquo;Save as PDF&rdquo; for a digital copy.
      </div>
    </div>
  );
}

function emptyGame(): GameLineup {
  return { innings: Array.from({ length: 8 }, () => ({}) as InningLineup) };
}

function PrintableGame({
  gameNum,
  game,
  attending,
  mode,
  nameByKey,
  startTime,
  homeAway,
}: {
  gameNum: number;
  game: GameLineup;
  attending: string[];
  mode: LineupMode;
  nameByKey: Map<string, string>;
  startTime?: string;
  homeAway?: "home" | "away";
}) {
  const order = resolveOrder(attending, game.batting_order, nameByKey);
  const positions = POSITIONS_BY_MODE[mode];

  // Per-player innings played (fielding only).
  const ip = new Map<string, number>();
  for (const row of game.innings) {
    for (const pk of Object.values(row)) {
      if (pk) ip.set(pk, (ip.get(pk) ?? 0) + 1);
    }
  }

  return (
    <section className="mb-6 break-inside-avoid">
      <div className="mb-1 flex items-baseline justify-between border-b border-stone-700 pb-1">
        <h2 className="text-lg font-bold">Game {gameNum}</h2>
        {(startTime || homeAway) && (
          <span className="text-sm text-stone-700">
            {startTime ?? ""}
            {homeAway ? ` (${homeAway})` : ""}
          </span>
        )}
      </div>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b-2 border-stone-700 bg-stone-100">
            <th className="border border-stone-400 px-1 py-1 text-center font-bold">#</th>
            <th className="border border-stone-400 px-2 py-1 text-left font-bold">Player</th>
            {INNINGS.map((i) => (
              <th key={i} className="border border-stone-400 px-1 py-1 text-center font-bold">
                I{i}
              </th>
            ))}
            <th className="border border-stone-400 px-1 py-1 text-center font-bold" title="Innings played">
              IP
            </th>
          </tr>
        </thead>
        <tbody>
          {order.map((pk, idx) => (
            <tr key={pk} className="even:bg-stone-50">
              <td className="border border-stone-300 px-1 py-1 text-center font-semibold tabular-nums">
                {idx + 1}
              </td>
              <td className="border border-stone-300 px-2 py-1 font-semibold">
                {nameByKey.get(pk) ?? pk}
              </td>
              {INNINGS.map((inning) => {
                const inningIdx = (inning as number) - 1;
                const row = game.innings[inningIdx] ?? {};
                const pos = posInInning(row, pk);
                return (
                  <td
                    key={inning}
                    className={`border border-stone-300 px-1 py-1 text-center tabular-nums ${
                      pos ? "font-semibold" : "text-stone-400"
                    }`}
                  >
                    {pos ? positionLabel(pos, mode) : "—"}
                  </td>
                );
              })}
              <td className="border border-stone-300 px-1 py-1 text-center tabular-nums">
                {ip.get(pk) ?? 0}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-stone-700 bg-stone-100 text-[11px]">
            <td className="border border-stone-400 px-1 py-1 text-center font-bold" colSpan={2}>
              Defensive lineup
            </td>
            {INNINGS.map((inning) => {
              const inningIdx = (inning as number) - 1;
              const row = game.innings[inningIdx] ?? {};
              const filled = positions.filter((p) => row[p]).length;
              const totalSlots = positions.length;
              return (
                <td
                  key={inning}
                  className={`border border-stone-400 px-1 py-1 text-center tabular-nums ${
                    filled < totalSlots ? "text-red-700 font-bold" : "text-stone-700"
                  }`}
                >
                  {filled}/{totalSlots}
                </td>
              );
            })}
            <td className="border border-stone-400 px-1 py-1" />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
