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
import { applyRosterOverrides, getActiveRoster, slugifyKey } from "@/lib/data";

const MARK_CYCLE: Record<Mark, Mark> = {
  none: "can",
  can: "should",
  should: "none",
};

// Compact pill labels — preserve the canonical position values (LCF/RCF/1B/...)
// in storage, but show shorter labels on the pills so they fit inline.
const PILL_LABEL: Record<Pos, string> = {
  "1B": "1",
  "2B": "2",
  "3B": "3",
  SS: "SS",
  P: "P",
  C: "C",
  LF: "LF",
  LCF: "LC",
  RCF: "RC",
  RF: "RF",
};
// Display order mirrors a typical lineup card: infield first, then outfield.
const PILL_ORDER: Pos[] = ["1B", "2B", "3B", "SS", "P", "C", "LF", "LCF", "RCF", "RF"];

function pillClass(m: Mark): string {
  // Three colour states: grey (none) → amber (can) → green (should)
  if (m === "should") {
    return "bg-emerald-500 text-white border-emerald-600 shadow-sm";
  }
  if (m === "can") {
    return "bg-amber-300 text-amber-950 border-amber-400";
  }
  return "bg-stone-100 text-stone-500 border-stone-200 hover:bg-stone-200";
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
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  // Final active set: (auto-active ∪ lineup.added) − lineup.archived. Sorted
  // by career BMBL+ desc so the top regulars come first.
  const activePlayers = useMemo(() => {
    if (!snapshot) return [] as { key: string; name: string }[];
    const roster = applyRosterOverrides(snapshot, {
      archived: lineup.archived,
      added: lineup.added,
    });
    return roster
      .slice()
      .sort((a, b) => {
        const ca = snapshot.career_weighted[a.key]?.career_BMBLplus_weighted ?? -1;
        const cb = snapshot.career_weighted[b.key]?.career_BMBLplus_weighted ?? -1;
        return cb - ca;
      })
      .map((p) => ({ key: p.key, name: p.display_name }));
  }, [snapshot, lineup.added, lineup.archived]);

  // Anyone who's been manually archived OR auto-dropped (not active, not
  // currently shown). Listed in alpha order in the archived panel.
  const archivedPlayers = useMemo(() => {
    if (!snapshot) return [] as { key: string; name: string }[];
    const activeKeys = new Set(activePlayers.map((p) => p.key));
    const all = new Map<string, string>();
    for (const [k, p] of Object.entries(snapshot.players)) {
      all.set(k, p.display_name || k);
    }
    for (const a of lineup.added) {
      if (!all.has(a.key)) all.set(a.key, a.display_name);
    }
    const out: { key: string; name: string }[] = [];
    for (const [key, name] of all) {
      if (!activeKeys.has(key)) out.push({ key, name });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [snapshot, activePlayers, lineup.added]);

  const filtered = useMemo(() => {
    if (!search.trim()) return activePlayers;
    const q = search.toLowerCase();
    return activePlayers.filter((p) => p.name.toLowerCase().includes(q));
  }, [activePlayers, search]);

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
          archived: Array.isArray(body.archived) ? body.archived : [],
          added: Array.isArray(body.added) ? body.added : [],
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

  function markDirty() {
    setDirty(true);
    setSaveMsg(null);
  }

  function archivePlayer(key: string) {
    markDirty();
    setLineup((prev) => {
      const archived = prev.archived.includes(key)
        ? prev.archived
        : [...prev.archived, key];
      // If they were in `added`, dropping them from there too keeps state clean.
      const added = prev.added.filter((a) => a.key !== key);
      return { ...prev, archived, added };
    });
  }

  function unarchivePlayer(key: string, displayName: string) {
    markDirty();
    setLineup((prev) => {
      const archived = prev.archived.filter((k) => k !== key);
      // If the auto-rule won't pick them up, also pin them via `added` so they
      // actually show. (Safe to over-add — applyRosterOverrides dedupes.)
      const inAuto = snapshot
        ? getActiveRoster(snapshot).some((p) => p.key === key)
        : false;
      let added = prev.added;
      if (!inAuto && !prev.added.some((a) => a.key === key)) {
        added = [...prev.added, { key, display_name: displayName }];
      }
      return { ...prev, archived, added };
    });
  }

  function addNewPlayer(name: string) {
    const trimmed = name.trim();
    if (!trimmed) {
      setAddError("Enter a name first.");
      return;
    }
    const key = slugifyKey(trimmed);
    if (!key) {
      setAddError("Couldn't make a key from that name.");
      return;
    }
    if (activePlayers.some((p) => p.key === key)) {
      setAddError(`${trimmed} is already in the active list.`);
      return;
    }
    setAddError(null);
    markDirty();
    setLineup((prev) => {
      const archived = prev.archived.filter((k) => k !== key);
      let added = prev.added;
      if (!added.some((a) => a.key === key)) {
        added = [...added, { key, display_name: trimmed }];
      }
      return { ...prev, archived, added };
    });
    setNewName("");
  }

  function getMark(key: string, pos: Pos): Mark {
    return lineup.matrix[key]?.[pos] ?? "none";
  }

  function cyclePill(key: string, pos: Pos) {
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
        archived: Array.isArray(saved.archived) ? saved.archived : [],
        added: Array.isArray(saved.added) ? saved.added : [],
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
    <div className="space-y-3">
      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-200 bg-white p-3 shadow-sm">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter players…"
          className="min-h-11 flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <label className="inline-flex items-center gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived ({archivedPlayers.length})
        </label>
        <Legend />
        <span className="text-xs text-stone-500">
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

      {serverError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {serverError}
        </div>
      )}
      {saveMsg && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {saveMsg}
        </div>
      )}

      {/* Player rows with inline pills */}
      <ul className="space-y-1 rounded-2xl border border-amber-200 bg-white p-2 shadow-sm">
        {filtered.map((p, idx) => (
          <li
            key={p.key}
            className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-2 py-2 ${
              idx % 2 === 0 ? "bg-white" : "bg-stone-50/50"
            }`}
          >
            <span className="min-w-[6.5rem] font-semibold text-stone-900">{p.name}</span>
            <div className="flex flex-wrap gap-1">
              {PILL_ORDER.map((pos) => {
                const m = getMark(p.key, pos);
                return (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => cyclePill(p.key, pos)}
                    aria-label={`${p.name} ${pos}: ${m}`}
                    className={`inline-flex h-8 min-w-[2.25rem] items-center justify-center rounded-full border px-2 text-xs font-semibold tabular-nums transition ${pillClass(
                      m,
                    )}`}
                  >
                    {PILL_LABEL[pos]}
                  </button>
                );
              })}
            </div>
            <input
              type="text"
              value={lineup.notes[p.key] ?? ""}
              onChange={(e) => setNote(p.key, e.target.value)}
              placeholder="notes…"
              className="min-h-9 w-full min-w-[8rem] flex-1 rounded-md border border-stone-200 bg-white px-2 py-1 text-sm focus:border-amber-500 focus:outline-none sm:w-auto sm:max-w-[18rem]"
            />
            <button
              type="button"
              onClick={() => archivePlayer(p.key)}
              title={`Archive ${p.name}`}
              className="min-h-9 rounded-md border border-stone-300 bg-white px-2 py-1 text-xs text-stone-600 hover:border-amber-400 hover:bg-amber-50 hover:text-amber-800"
            >
              Archive
            </button>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="px-3 py-6 text-center text-stone-500">No players match.</li>
        )}
      </ul>

      {/* Add-player form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          addNewPlayer(newName);
        }}
        className="flex flex-wrap items-center gap-2 rounded-2xl border border-amber-200 bg-white p-3 shadow-sm"
      >
        <label className="text-sm font-semibold text-amber-900">Add player</label>
        <input
          type="text"
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            setAddError(null);
          }}
          placeholder="First name (e.g. Tony)"
          className="min-h-9 flex-1 rounded-md border border-stone-300 px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={!newName.trim()}
          className="min-h-9 rounded-md border border-amber-400 bg-amber-100 px-3 py-1.5 text-sm font-semibold text-amber-900 hover:bg-amber-200 disabled:opacity-50"
        >
          + Add
        </button>
        {addError && (
          <span className="text-xs text-red-700">{addError}</span>
        )}
      </form>

      {/* Archived panel */}
      {showArchived && (
        <div className="rounded-2xl border border-stone-200 bg-stone-50 p-3 shadow-sm">
          <div className="mb-2 text-sm font-semibold text-stone-700">
            Archived ({archivedPlayers.length})
          </div>
          {archivedPlayers.length === 0 ? (
            <p className="text-xs text-stone-500 italic">No archived players.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {archivedPlayers.map((p) => (
                <li key={p.key}>
                  <button
                    type="button"
                    onClick={() => unarchivePlayer(p.key, p.name)}
                    className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-white px-3 py-1 text-sm text-stone-700 hover:border-emerald-500 hover:bg-emerald-50 hover:text-emerald-800"
                  >
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-stone-400">↩</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-xs text-stone-500">
        Tap a pill to cycle: <span className="font-semibold text-stone-500">grey</span> →{" "}
        <span className="font-semibold text-amber-700">can play</span> →{" "}
        <span className="font-semibold text-emerald-700">should play</span> → grey.
        {" "}{activePlayers.length} active · {archivedPlayers.length} archived.
      </p>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-2 text-xs text-stone-600">
      <span className="inline-flex h-6 min-w-7 items-center justify-center rounded-full border border-stone-200 bg-stone-100 px-2 font-semibold text-stone-500">
        SS
      </span>
      <span className="text-stone-400">→</span>
      <span className="inline-flex h-6 min-w-7 items-center justify-center rounded-full border border-amber-400 bg-amber-300 px-2 font-semibold text-amber-950">
        SS
      </span>
      <span className="text-stone-400">→</span>
      <span className="inline-flex h-6 min-w-7 items-center justify-center rounded-full border border-emerald-600 bg-emerald-500 px-2 font-semibold text-white">
        SS
      </span>
    </div>
  );
}
