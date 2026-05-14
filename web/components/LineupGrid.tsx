"use client";

import { useEffect, useMemo, useState } from "react";
import { useSnapshot } from "@/lib/useSnapshot";
import {
  EMPTY_LINEUP,
  type Lineup,
  type Mark,
  type Pos,
  POSITIONS,
} from "@/lib/lineup";

const MARK_CYCLE: Record<Mark, Mark> = {
  none: "can",
  can: "should",
  should: "none",
};

function markStyle(m: Mark): string {
  if (m === "should") return "bg-emerald-600 text-white";
  if (m === "can") return "bg-amber-200 text-amber-900";
  return "bg-white text-stone-300 hover:bg-stone-50";
}

function markLabel(m: Mark): string {
  if (m === "should") return "★";
  if (m === "can") return "✓";
  return "·";
}

function formatTimestamp(iso: string): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function LineupGrid() {
  const { snapshot, error: snapErr } = useSnapshot();
  const [lineup, setLineup] = useState<Lineup>(EMPTY_LINEUP);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  // Players from snapshot, ordered by career BMBL+ desc (active hitters first).
  const players = useMemo(() => {
    if (!snapshot) return [] as { key: string; name: string }[];
    const keys = Object.keys(snapshot.players).sort((a, b) => {
      const ca = snapshot.career_weighted[a]?.career_BMBLplus_weighted ?? -1;
      const cb = snapshot.career_weighted[b]?.career_BMBLplus_weighted ?? -1;
      return cb - ca;
    });
    return keys.map((k) => ({
      key: k,
      name: snapshot.players[k].display_name || k,
    }));
  }, [snapshot]);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    fetch("/api/lineup", { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => EMPTY_LINEUP);
        if (cancelled) return;
        setLineup({
          matrix: body.matrix ?? {},
          notes: body.notes ?? {},
          updated_at: body.updated_at ?? "",
        });
        setLoaded(true);
        if (r.headers.get("x-bb-storage") === "unconfigured") {
          setServerError(
            "Storage isn't configured yet. Changes will not persist until KV_REST_API_URL + KV_REST_API_TOKEN are set in Vercel.",
          );
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setServerError("Failed to load lineup: " + (e?.message ?? "unknown"));
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function getMark(key: string, pos: Pos): Mark {
    return lineup.matrix[key]?.[pos] ?? "none";
  }

  function cycleCell(key: string, pos: Pos) {
    setDirty(true);
    setSaveMsg(null);
    setLineup((prev) => {
      const row = { ...(prev.matrix[key] ?? {}) };
      const next = MARK_CYCLE[getMark(key, pos)];
      if (next === "none") delete row[pos];
      else row[pos] = next;
      const matrix = { ...prev.matrix };
      if (Object.keys(row).length === 0) delete matrix[key];
      else matrix[key] = row;
      return { ...prev, matrix };
    });
  }

  function setNote(key: string, val: string) {
    setDirty(true);
    setSaveMsg(null);
    setLineup((prev) => {
      const notes = { ...prev.notes };
      if (val.trim()) notes[key] = val;
      else delete notes[key];
      return { ...prev, notes };
    });
  }

  async function save() {
    setSaving(true);
    setSaveMsg(null);
    setServerError(null);
    try {
      const res = await fetch("/api/lineup", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(lineup),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const saved = (await res.json()) as Lineup;
      setLineup({
        matrix: saved.matrix ?? {},
        notes: saved.notes ?? {},
        updated_at: saved.updated_at ?? "",
      });
      setDirty(false);
      setSaveMsg("Saved.");
    } catch (e) {
      setServerError("Save failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }

  if (snapErr) {
    return <p className="text-red-700">Failed to load roster: {snapErr.message}</p>;
  }
  if (!snapshot || !loaded) {
    return <p className="text-stone-500">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-200 bg-white p-3 shadow-sm">
        <span className="text-sm text-stone-700">
          Tap each cell to cycle: <span className="font-semibold text-stone-400">·</span> none →{" "}
          <span className="font-semibold text-amber-700">✓</span> can play →{" "}
          <span className="font-semibold text-emerald-700">★</span> should play.
        </span>
        <span className="ml-auto text-xs text-stone-500">
          Last saved: {formatTimestamp(lineup.updated_at)}
        </span>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="min-h-11 rounded-md bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
        >
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
      </div>

      {serverError ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {serverError}
        </div>
      ) : null}
      {saveMsg ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {saveMsg}
        </div>
      ) : null}

      {/* Grid */}
      <div className="overflow-x-auto rounded-2xl border border-amber-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="sticky top-0 z-10 bg-amber-50">
            <tr>
              <th className="sticky left-0 z-20 min-w-[10rem] bg-amber-50 px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-600">
                Player
              </th>
              {POSITIONS.map((p) => (
                <th
                  key={p}
                  className="px-2 py-3 text-center text-xs font-semibold uppercase tracking-wide text-stone-600"
                >
                  {p}
                </th>
              ))}
              <th className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wide text-stone-600">
                Notes
              </th>
            </tr>
          </thead>
          <tbody>
            {players.map((pl, idx) => (
              <tr
                key={pl.key}
                className={idx % 2 === 0 ? "bg-white" : "bg-stone-50/60"}
              >
                <td className="sticky left-0 z-10 whitespace-nowrap bg-inherit px-3 py-2 font-medium text-stone-900">
                  {pl.name}
                </td>
                {POSITIONS.map((p) => {
                  const m = getMark(pl.key, p);
                  return (
                    <td key={p} className="px-1 py-1">
                      <button
                        type="button"
                        onClick={() => cycleCell(pl.key, p)}
                        aria-label={`${pl.name} ${p}: ${m}`}
                        className={`block h-11 w-11 rounded-md border border-stone-200 text-lg font-bold transition ${markStyle(m)}`}
                      >
                        {markLabel(m)}
                      </button>
                    </td>
                  );
                })}
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={lineup.notes[pl.key] ?? ""}
                    onChange={(e) => setNote(pl.key, e.target.value)}
                    placeholder="—"
                    className="min-h-9 w-full min-w-[12rem] rounded-md border border-stone-200 bg-white px-2 py-1 text-sm focus:border-amber-500 focus:outline-none"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
