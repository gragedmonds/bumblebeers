"use client";

// Top-level client component for /lineup/[date]: loads the night state +
// shared prefs + schedule + roster snapshot, hosts the AttendanceEditor
// and LineupBuilder, handles save.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AttendanceEditor from "./AttendanceEditor";
import LineupBuilder from "./LineupBuilder";
import { useSnapshot } from "@/lib/useSnapshot";
import { EMPTY_LINEUP, type Lineup } from "@/lib/lineup";
import { applyRosterOverrides } from "@/lib/data";
import {
  emptyNight,
  type Availability,
  type GameLineup,
  type PersistedNight,
} from "@/lib/night";
import type { NightSchedule } from "@/lib/schedule";

interface ScheduleResponse {
  nights: NightSchedule[];
}

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

export default function NightPlanner({ date }: { date: string }) {
  const { snapshot } = useSnapshot();
  const [night, setNight] = useState<PersistedNight>(() => emptyNight(date));
  const [prefs, setPrefs] = useState<Lineup>(EMPTY_LINEUP);
  const [schedule, setSchedule] = useState<NightSchedule | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Active roster honoring the manual overrides set on /lineup
  // (archived + added). Retirees and casual subs stay hidden by default;
  // anything Greg explicitly archived/added flows through here too.
  const roster = useMemo(() => {
    if (!snapshot) return [] as { key: string; display_name: string }[];
    return applyRosterOverrides(snapshot, {
      archived: prefs.archived ?? [],
      added: prefs.added ?? [],
    });
  }, [snapshot, prefs.archived, prefs.added]);

  // Attendees from night status
  const attending = useMemo(
    () =>
      Object.entries(night.attendance.status)
        .filter(([, v]) => v === "in")
        .map(([k]) => k),
    [night],
  );

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [nightR, prefsR, schedR] = await Promise.all([
          fetch(`/api/night/${encodeURIComponent(date)}`, { cache: "no-store" }),
          fetch("/api/lineup", { cache: "no-store" }),
          fetch("/api/schedule", { cache: "no-store" }),
        ]);
        const nightJson = (await nightR.json()) as {
          night?: PersistedNight;
          error?: string;
        };
        const prefsJson = (await prefsR.json()) as Lineup & { error?: string };
        const schedJson = (await schedR.json()) as ScheduleResponse;
        if (cancelled) return;
        if (nightJson.night) setNight(nightJson.night);
        else setNight(emptyNight(date));
        if (nightJson.error === "upstash_not_configured") setStorageOk(false);
        if (prefsJson) {
          const pj = prefsJson as Lineup & {
            handedness?: unknown;
            beers_by_season?: unknown;
          };
          setPrefs({
            matrix: pj.matrix ?? {},
            team_notes: typeof pj.team_notes === "string" ? pj.team_notes : "",
            archived: Array.isArray(pj.archived) ? pj.archived : [],
            added: Array.isArray(pj.added) ? pj.added : [],
            handedness:
              pj.handedness && typeof pj.handedness === "object"
                ? (pj.handedness as Lineup["handedness"])
                : {},
            beers_by_season:
              pj.beers_by_season && typeof pj.beers_by_season === "object"
                ? (pj.beers_by_season as Lineup["beers_by_season"])
                : {},
            updated_at: pj.updated_at ?? "",
          });
        }
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

  const updateAttendance = useCallback(
    (next: {
      status: Record<string, Availability>;
      unmatched_in: string[];
      unmatched_out: string[];
    }) => {
      setDirty(true);
      setSavedMsg(null);
      setNight((prev) => ({
        ...prev,
        attendance: { ...next },
      }));
    },
    [],
  );

  const updateGames = useCallback((games: GameLineup[]) => {
    setDirty(true);
    setSavedMsg(null);
    setNight((prev) => ({ ...prev, games }));
  }, []);

  // Auto-save: debounce 700ms after any change to night state. Ref-pattern
  // so the PUT always serialises the latest state, even if the user keeps
  // editing while the previous save is in flight.
  const latestNightRef = useRef(night);
  useEffect(() => {
    latestNightRef.current = night;
  }, [night]);

  useEffect(() => {
    if (!loaded || !dirty) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      setErr(null);
      try {
        const r = await fetch(`/api/night/${encodeURIComponent(date)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(latestNightRef.current),
        });
        const json = (await r.json()) as {
          night?: PersistedNight;
          error?: string;
          detail?: string;
        };
        if (!r.ok) {
          const friendly =
            json.error === "upstash_not_configured"
              ? "Storage isn't configured yet — add the Upstash Redis integration in Vercel."
              : json.detail || json.error || `HTTP ${r.status}`;
          throw new Error(friendly);
        }
        if (json.night) {
          // Bump only the updated_at — leave the rest of the local state
          // alone in case the user kept editing during the round-trip.
          setNight((prev) => ({
            ...prev,
            updated_at: json.night?.updated_at ?? prev.updated_at,
          }));
        }
        setDirty(false);
        setSavedMsg("Saved.");
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setSaving(false);
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [night, dirty, loaded, date]);

  if (!loaded) {
    return <p className="text-stone-500">Loading…</p>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-amber-700">Game night</div>
          <h1 className="text-3xl font-bold text-amber-900">{formatDateLong(date)}</h1>
          {schedule ? (
            <p className="mt-1 text-stone-700">
              vs <span className="font-semibold">{schedule.opponent}</span> · @ {schedule.location}
              {" · "}
              {schedule.games
                .map((g) => `${g.time} ${g.homeAway === "home" ? "(home)" : "(away)"}`)
                .join(" + ")}
            </p>
          ) : (
            <p className="mt-1 text-stone-500">
              No matching night on the schedule. You can still build a lineup if this is a one-off.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/lineup"
            className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm hover:bg-stone-100"
          >
            ← All nights
          </Link>
          <span className="text-xs text-stone-500">
            {saving
              ? "Saving…"
              : dirty
                ? "Unsaved (auto-saves in a moment)"
                : "All changes saved"}
          </span>
        </div>
      </div>

      {!storageOk && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Storage isn&apos;t configured yet — add the Upstash Redis integration in Vercel so saves persist.
        </div>
      )}
      {savedMsg && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {savedMsg}
        </div>
      )}
      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </div>
      )}

      <AttendanceEditor
        roster={roster}
        status={night.attendance.status}
        unmatchedIn={night.attendance.unmatched_in}
        unmatchedOut={night.attendance.unmatched_out}
        onChange={updateAttendance}
      />

      <LineupBuilder
        roster={roster}
        attending={attending}
        prefs={prefs}
        games={night.games}
        opponent={schedule?.opponent ?? null}
        printHref={`/lineup/${encodeURIComponent(date)}/print`}
        onChange={updateGames}
      />
    </div>
  );
}
