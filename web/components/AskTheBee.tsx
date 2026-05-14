"use client";

// Chat-style UI for /ask. Streams responses via SSE from /api/ask, renders
// each assistant turn as markdown. History is session-only (kept in state).

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Final usage stats — attached to assistant turns after the `done` event. */
  meta?: {
    model: string;
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  };
}

const SAMPLES = [
  "Who has the highest career BMBL+?",
  "Show the top 5 MVP-night winners of all time.",
  "Which players had the best 2024 season by BMBL+?",
  "Who's the most clutch hitter — best RISP rate?",
];

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function streamAsk(
  body: { question: string; history: { role: "user" | "assistant"; content: string }[] },
  smart: boolean,
  onText: (delta: string) => void,
  onDone: (meta: Turn["meta"]) => void,
  onError: (msg: string) => void,
  signal: AbortSignal,
) {
  const url = "/api/ask" + (smart ? "?smart=1" : "");
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    onError(`HTTP ${r.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
    return;
  }
  if (!r.body) {
    onError("No response body.");
    return;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Split on SSE event boundary (blank line)
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = raw.split("\n");
      let evt = "message";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) evt = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        if (evt === "text" && typeof parsed.delta === "string") {
          onText(parsed.delta);
        } else if (evt === "done") {
          onDone({
            model: parsed.model,
            input: parsed.usage?.input ?? 0,
            output: parsed.usage?.output ?? 0,
            cache_read: parsed.usage?.cache_read ?? 0,
            cache_creation: parsed.usage?.cache_creation ?? 0,
          });
        } else if (evt === "error") {
          onError(parsed.detail || parsed.error || "stream_error");
        }
      } catch {
        // Skip malformed frames
      }
    }
  }
}

export default function AskTheBee() {
  const [thread, setThread] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [smart, setSmart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread]);

  const send = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;
      setErr(null);
      const history = thread.map((t) => ({ role: t.role, content: t.content }));
      const userTurn: Turn = { id: newId(), role: "user", content: q };
      const assistantTurn: Turn = { id: newId(), role: "assistant", content: "" };
      setThread((t) => [...t, userTurn, assistantTurn]);
      setDraft("");
      setBusy(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        await streamAsk(
          { question: q, history },
          smart,
          (delta) => {
            setThread((t) => {
              const copy = t.slice();
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") {
                copy[copy.length - 1] = { ...last, content: last.content + delta };
              }
              return copy;
            });
          },
          (meta) => {
            setThread((t) => {
              const copy = t.slice();
              const last = copy[copy.length - 1];
              if (last && last.role === "assistant") {
                copy[copy.length - 1] = { ...last, meta };
              }
              return copy;
            });
          },
          (msg) => setErr(msg),
          ctrl.signal,
        );
      } catch (e: unknown) {
        if ((e as Error).name !== "AbortError") {
          setErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, smart, thread],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setThread([]);
    setErr(null);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-white p-3 shadow-sm">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={smart}
            onChange={(e) => setSmart(e.target.checked)}
          />
          Deep mode (Opus 4.7 — slower, smarter)
        </label>
        <div className="flex gap-2">
          {busy && (
            <button
              type="button"
              onClick={stop}
              className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm hover:bg-stone-100"
            >
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={reset}
            disabled={thread.length === 0 || busy}
            className="min-h-11 rounded-md border border-stone-300 px-3 py-2 text-sm hover:bg-stone-100 disabled:opacity-50"
          >
            New conversation
          </button>
        </div>
      </div>

      <div className="min-h-[60vh] space-y-3 rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
        {thread.length === 0 ? (
          <div className="text-stone-600">
            <p className="mb-3">Ask anything about the Bumblebeers. Try one of these to start:</p>
            <ul className="space-y-2">
              {SAMPLES.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => send(s)}
                    className="min-h-11 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left text-sm text-amber-900 hover:bg-amber-100"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          thread.map((t) => (
            <div
              key={t.id}
              className={
                t.role === "user"
                  ? "rounded-lg bg-stone-100 p-3"
                  : "rounded-lg border border-amber-100 bg-amber-50/40 p-3"
              }
            >
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
                {t.role === "user" ? "You" : "🐝 Bee"}
              </div>
              {t.role === "user" ? (
                <p className="whitespace-pre-wrap text-stone-900">{t.content}</p>
              ) : (
                <div className="prose prose-stone prose-sm max-w-none">
                  {t.content ? (
                    <ReactMarkdown>{t.content}</ReactMarkdown>
                  ) : (
                    <p className="italic text-stone-500">Thinking…</p>
                  )}
                </div>
              )}
              {t.meta && (
                <div className="mt-2 border-t border-stone-200 pt-2 text-[11px] text-stone-400">
                  {t.meta.model} · {t.meta.input + t.meta.cache_read + t.meta.cache_creation} in
                  {" / "}
                  {t.meta.output} out
                  {t.meta.cache_read > 0 && (
                    <span className="ml-1 text-emerald-600">
                      (cache hit: {t.meta.cache_read.toLocaleString()} tokens)
                    </span>
                  )}
                  {t.meta.cache_creation > 0 && (
                    <span className="ml-1 text-amber-700">
                      (cache write: {t.meta.cache_creation.toLocaleString()})
                    </span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
        className="flex flex-col gap-2 rounded-2xl border border-amber-200 bg-white p-3 shadow-sm"
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send(draft);
            }
          }}
          placeholder="Ask the Bee anything about the Bumblebeers stats…"
          rows={3}
          disabled={busy}
          className="min-h-24 w-full resize-y rounded-md border border-stone-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none disabled:bg-stone-50"
        />
        <div className="flex items-center justify-between text-xs text-stone-500">
          <span>⌘/Ctrl + Enter to send</span>
          <button
            type="submit"
            disabled={!draft.trim() || busy}
            className="min-h-11 rounded-md bg-amber-700 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
          >
            {busy ? "Thinking…" : "Ask"}
          </button>
        </div>
      </form>
    </div>
  );
}
