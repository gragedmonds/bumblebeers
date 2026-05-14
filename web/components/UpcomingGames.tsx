"use client";

// Pulls /api/schedule (which scrapes HTOSports) and shows the next few
// game nights. Phase 4d will turn the "Plan tonight's lineup" buttons into
// real edit links.

import Link from "next/link";
import { useEffect, useState } from "react";
import type { NightSchedule } from "@/lib/schedule";

interface ScheduleResponse {
  source: string;
  fetched_at: string;
  nights: NightSchedule[];
  error?: string;
}

const TORONTO_TZ = "America/Toronto";

function todayInToronto(): string {
  // Format as YYYY-MM-DD in Toronto time so "tonight" lines up with the
  // schedule's date even when the host server is on UTC.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TORONTO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function relative(date: string): string {
  const today = todayInToronto();
  if (date === today) return "Tonight";
  const t = new Date(today + "T00:00:00");
  const d = new Date(date + "T00:00:00");
  const diffDays = Math.round((d.getTime() - t.getTime()) / 86400000);
  if (diffDays === 1) return "Tomorrow";
  if (diffDays > 1 && diffDays <= 6) return `In ${diffDays} days`;
  if (diffDays < 0 && diffDays >= -6) return `${Math.abs(diffDays)}d ago`;
  return "";
}

export default function UpcomingGames({ limit = 3 }: { limit?: number }) {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/schedule", { cache: "no-store" })
      .then(async (r) => {
        const json = (await r.json()) as ScheduleResponse;
        if (cancelled) return;
        if (!r.ok && json.error) {
          setError(json.error);
          return;
        }
        setData(json);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
        Couldn&apos;t load schedule: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-white p-3 text-sm text-stone-500 shadow-sm">
        Loading schedule…
      </div>
    );
  }

  const today = todayInToronto();
  const upcoming = data.nights.filter((n) => n.date >= today).slice(0, limit);

  if (upcoming.length === 0) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-white p-3 text-sm text-stone-500 shadow-sm">
        No upcoming games on the schedule.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-amber-900">Upcoming games</h2>
        <a
          href={data.source}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-amber-700 hover:underline"
        >
          full schedule ↗
        </a>
      </div>
      <ul className="space-y-2">
        {upcoming.map((n) => {
          const rel = relative(n.date);
          return (
            <li key={n.date}>
              <Link
                href={`/lineup/${n.date}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-100 bg-amber-50/40 p-3 transition hover:border-amber-300 hover:bg-amber-50"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-bold text-stone-900">
                    {n.day} · {fmtDate(n.date)}
                  </span>
                  {rel && (
                    <span className="rounded-full bg-amber-700 px-2 py-0.5 text-xs font-semibold text-white">
                      {rel}
                    </span>
                  )}
                  <span className="text-stone-700">
                    vs <span className="font-semibold">{n.opponent}</span>
                  </span>
                  <span className="text-xs text-stone-500">@ {n.location}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {n.games.map((g, i) => (
                    <span
                      key={i}
                      className={`rounded-md border px-2 py-1 ${
                        g.homeAway === "home"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                          : "border-stone-300 bg-white text-stone-700"
                      }`}
                    >
                      {g.time}
                      <span className="ml-1 text-[10px] uppercase">
                        {g.homeAway === "home" ? "home" : "away"}
                      </span>
                    </span>
                  ))}
                  <span className="text-amber-800">Plan →</span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-stone-400">
        Updated {new Date(data.fetched_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}.
        Refreshed at most every hour.
      </p>
    </div>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
