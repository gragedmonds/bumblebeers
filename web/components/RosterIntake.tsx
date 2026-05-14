"use client";

// Upload a poll-results screenshot, send it to Claude vision, render the
// "in" / "out" buckets it found, plus anything it saw that didn't match our
// roster. Phase 4d will wire the chosen "in" set to a night-attendance KV
// entry — for now this is parse-and-preview only.

import { useCallback, useRef, useState } from "react";

type Bucket = {
  key: string;
  display_name: string;
  raw: string;
  reason: string;
};

interface ParseResponse {
  in: Bucket[];
  out: Bucket[];
  unmatched_in: string[];
  unmatched_out: string[];
  model: string;
  error?: string;
  detail?: string;
}

async function fileToBase64(file: File): Promise<{ data: string; media: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("not_data_url"));
        return;
      }
      // data:image/png;base64,XXXX  →  { media: "image/png", data: "XXXX" }
      const m = result.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) {
        reject(new Error("bad_data_url"));
        return;
      }
      resolve({ media: m[1], data: m[2] });
    };
    reader.readAsDataURL(file);
  });
}

export default function RosterIntake() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ParseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const pick = useCallback((f: File | null) => {
    setError(null);
    setResult(null);
    if (!f) {
      setFile(null);
      setPreview(null);
      return;
    }
    if (!f.type.startsWith("image/")) {
      setError("That doesn't look like an image.");
      return;
    }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }, []);

  const submit = useCallback(async () => {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
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
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [file]);

  const clear = useCallback(() => {
    pick(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [pick]);

  return (
    <div className="space-y-3 rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-amber-900">Who&apos;s in tonight?</h2>
        <span className="text-xs text-stone-500">
          Upload a poll screenshot — Claude reads the names and matches to the roster.
        </span>
      </div>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0] ?? null;
          pick(f);
        }}
        className={`flex min-h-32 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-4 text-sm transition ${
          dragging
            ? "border-amber-500 bg-amber-50"
            : "border-stone-300 bg-stone-50 hover:bg-amber-50"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="sr-only"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
        {preview ? (
          <div className="flex w-full flex-wrap items-center gap-3">
            <img
              src={preview}
              alt="Poll preview"
              className="max-h-40 rounded-md border border-stone-200"
            />
            <div className="flex-1 text-stone-700">
              <div className="font-medium">{file?.name}</div>
              <div className="text-xs text-stone-500">
                {file ? `${Math.round(file.size / 1024)} KB · ${file.type}` : ""}
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  clear();
                }}
                className="mt-2 text-xs text-amber-700 hover:underline"
              >
                Choose a different image
              </button>
            </div>
          </div>
        ) : (
          <>
            <span className="font-medium text-stone-700">Drop a screenshot here</span>
            <span className="text-xs text-stone-500">
              or click to pick — PNG, JPEG, WebP, GIF
            </span>
          </>
        )}
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={!file || submitting}
          className="min-h-11 rounded-md bg-amber-700 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
        >
          {submitting ? "Asking the Bee…" : "Parse with Claude"}
        </button>
        {result || error ? (
          <button
            type="button"
            onClick={() => {
              clear();
              setResult(null);
              setError(null);
            }}
            className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm hover:bg-stone-100"
          >
            Reset
          </button>
        ) : null}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {result && <ParseResults result={result} />}
    </div>
  );
}

function ParseResults({ result }: { result: ParseResponse }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Bucket title="In tonight" tone="emerald" items={result.in} unmatched={result.unmatched_in} />
      <Bucket title="Out / Maybe" tone="stone" items={result.out} unmatched={result.unmatched_out} />
      <p className="md:col-span-2 text-xs text-stone-500">
        Parsed with <code className="rounded bg-stone-100 px-1">{result.model}</code>. Phase 4d
        will save the &ldquo;In&rdquo; list as tonight&rsquo;s attendance and build a lineup.
      </p>
    </div>
  );
}

function Bucket({
  title,
  tone,
  items,
  unmatched,
}: {
  title: string;
  tone: "emerald" | "stone";
  items: Bucket[];
  unmatched: string[];
}) {
  const ring =
    tone === "emerald"
      ? "border-emerald-300 bg-emerald-50"
      : "border-stone-300 bg-stone-50";
  return (
    <div className={`rounded-xl border ${ring} p-3 text-sm`}>
      <div className="mb-2 font-semibold text-stone-800">
        {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <p className="text-stone-500 italic">No matches.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((p) => (
            <li key={p.key} className="flex items-center justify-between gap-2">
              <span className="font-medium">{p.display_name}</span>
              <span className="text-xs text-stone-500">
                {p.raw !== p.display_name ? p.raw : ""}
                <span className="ml-2 rounded bg-white px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-500">
                  {p.reason}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {unmatched.length > 0 && (
        <div className="mt-3 border-t border-stone-200 pt-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            Roster didn&apos;t match ({unmatched.length})
          </div>
          <ul className="mt-1 list-disc pl-5 text-xs text-stone-600">
            {unmatched.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
