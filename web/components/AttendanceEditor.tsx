"use client";

// Per-night attendance editor: roster → IN/OUT toggle. Optional screenshot
// upload that auto-populates the status map via /api/attendance/parse.

import { useCallback, useState } from "react";
import type { Availability } from "@/lib/night";

interface RosterPlayer {
  key: string;
  display_name: string;
}

interface AttendanceEditorProps {
  roster: RosterPlayer[];
  status: Record<string, Availability>;
  unmatchedIn: string[];
  unmatchedOut: string[];
  onChange: (next: {
    status: Record<string, Availability>;
    unmatched_in: string[];
    unmatched_out: string[];
  }) => void;
}

interface ParseResponse {
  in: { key: string; display_name: string }[];
  out: { key: string; display_name: string }[];
  unmatched_in: string[];
  unmatched_out: string[];
  error?: string;
  detail?: string;
}

async function fileToBase64(file: File): Promise<{ data: string; media: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("not_data_url"));
      const m = result.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) return reject(new Error("bad_data_url"));
      resolve({ media: m[1], data: m[2] });
    };
    reader.readAsDataURL(file);
  });
}

export default function AttendanceEditor({
  roster,
  status,
  unmatchedIn,
  unmatchedOut,
  onChange,
}: AttendanceEditorProps) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [parseMsg, setParseMsg] = useState<string | null>(null);

  const setOne = useCallback(
    (key: string, val: Availability | null) => {
      const next = { ...status };
      if (val === null) delete next[key];
      else next[key] = val;
      onChange({ status: next, unmatched_in: unmatchedIn, unmatched_out: unmatchedOut });
    },
    [status, onChange, unmatchedIn, unmatchedOut],
  );

  const clearAll = useCallback(() => {
    onChange({ status: {}, unmatched_in: [], unmatched_out: [] });
  }, [onChange]);

  const handleUpload = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setBusy(true);
      setErr(null);
      setParseMsg(null);
      try {
        const { data, media } = await fileToBase64(file);
        const r = await fetch("/api/attendance/parse", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image_base64: data, image_media_type: media }),
        });
        const json = (await r.json()) as ParseResponse;
        if (!r.ok || json.error) {
          const friendly =
            json.error === "anthropic_not_configured"
              ? "Claude API key not set in this environment — add ANTHROPIC_API_KEY in Vercel."
              : json.detail || json.error || `HTTP ${r.status}`;
          throw new Error(friendly);
        }
        const merged: Record<string, Availability> = { ...status };
        json.in.forEach((p) => (merged[p.key] = "in"));
        json.out.forEach((p) => (merged[p.key] = "out"));
        onChange({
          status: merged,
          unmatched_in: json.unmatched_in,
          unmatched_out: json.unmatched_out,
        });
        setParseMsg(
          `Marked ${json.in.length} in, ${json.out.length} out from screenshot${
            json.unmatched_in.length + json.unmatched_out.length
              ? ` (${json.unmatched_in.length + json.unmatched_out.length} name(s) didn't match roster)`
              : ""
          }.`,
        );
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onChange, status],
  );

  const counts = { in: 0, out: 0, unknown: 0 };
  for (const p of roster) {
    const s = status[p.key];
    if (s === "in") counts.in++;
    else if (s === "out") counts.out++;
    else counts.unknown++;
  }

  return (
    <div className="space-y-3 rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-amber-900">Attendance</h2>
        <span className="text-xs text-stone-500">
          <b className="text-emerald-700">{counts.in}</b> in · <b className="text-stone-600">{counts.out}</b> out ·{" "}
          <b className="text-stone-400">{counts.unknown}</b> unknown
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="min-h-11 inline-flex cursor-pointer items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm hover:bg-stone-100">
          {busy ? "Parsing…" : "Upload poll screenshot"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              handleUpload(f);
              e.currentTarget.value = "";
            }}
          />
        </label>
        <button
          type="button"
          onClick={clearAll}
          className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm hover:bg-stone-100"
        >
          Clear all
        </button>
      </div>

      {parseMsg && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {parseMsg}
        </div>
      )}
      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </div>
      )}

      <ul className="grid gap-1 sm:grid-cols-2">
        {roster.map((p) => {
          const s = status[p.key];
          return (
            <li
              key={p.key}
              className="flex items-center justify-between gap-2 rounded-md border border-stone-100 bg-stone-50/40 px-3 py-2"
            >
              <span className="font-medium text-stone-800">{p.display_name}</span>
              <div className="flex gap-1">
                <Pill active={s === "in"} tone="emerald" onClick={() => setOne(p.key, s === "in" ? null : "in")}>
                  In
                </Pill>
                <Pill active={s === "out"} tone="stone" onClick={() => setOne(p.key, s === "out" ? null : "out")}>
                  Out
                </Pill>
              </div>
            </li>
          );
        })}
      </ul>

      {(unmatchedIn.length > 0 || unmatchedOut.length > 0) && (
        <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-xs">
          <div className="font-semibold uppercase tracking-wide text-stone-500">
            Names from the screenshot the roster didn&apos;t match
          </div>
          {unmatchedIn.length > 0 && (
            <p className="mt-1 text-stone-600">
              <b>In:</b> {unmatchedIn.join(", ")}
            </p>
          )}
          {unmatchedOut.length > 0 && (
            <p className="mt-1 text-stone-600">
              <b>Out/Maybe:</b> {unmatchedOut.join(", ")}
            </p>
          )}
          <p className="mt-2 text-stone-500">
            Add them as aliases in build_data_json.py if they should map to a roster player.
          </p>
        </div>
      )}
    </div>
  );
}

function Pill({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: "emerald" | "stone";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const cls = active
    ? tone === "emerald"
      ? "bg-emerald-600 border-emerald-700 text-white"
      : "bg-stone-600 border-stone-700 text-white"
    : "bg-white border-stone-300 text-stone-600 hover:bg-stone-100";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-11 min-w-11 rounded-md border px-3 py-1.5 text-sm font-medium ${cls}`}
    >
      {children}
    </button>
  );
}
