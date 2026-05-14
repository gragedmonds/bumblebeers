"use client";

// Persistent floating chat — "Ask Beeves" 🐝. A round button in the bottom-
// right of every page; tap it to open an inline chat panel (no navigation,
// no dedicated page). Closing the panel keeps the thread in memory so the
// next open continues where you left off within the same session.

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
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
  "Top 5 MVP-night winners of all time.",
  "Best 2024 hitters by BMBL+.",
  "Most clutch hitter — best RISP rate?",
];

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Module-scope thread so closing/reopening the panel within a session keeps
// the conversation context. Resets on full page reload (matches the rest of
// the app's read-only-public stance).
let cachedThread: Turn[] = [];

async function streamAsk(
  body: { question: string; history: { role: "user" | "assistant"; content: string }[] },
  onText: (delta: string) => void,
  onDone: (meta: Turn["meta"]) => void,
  onError: (msg: string) => void,
  signal: AbortSignal,
) {
  const r = await fetch("/api/ask", {
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
        if (evt === "text" && typeof parsed.delta === "string") onText(parsed.delta);
        else if (evt === "done")
          onDone({
            model: parsed.model,
            input: parsed.usage?.input ?? 0,
            output: parsed.usage?.output ?? 0,
            cache_read: parsed.usage?.cache_read ?? 0,
            cache_creation: parsed.usage?.cache_creation ?? 0,
          });
        else if (evt === "error") onError(parsed.detail || parsed.error || "stream_error");
      } catch {
        // Skip malformed frames.
      }
    }
  }
}

// Custom react-markdown components — restrained, compact styling tuned for a
// small chat panel. No reliance on @tailwindcss/typography.
const MD_COMPONENTS: Parameters<typeof ReactMarkdown>[0]["components"] = {
  p: (props) => <p className="my-1.5 leading-relaxed" {...props} />,
  ul: (props) => <ul className="my-1.5 list-disc space-y-0.5 pl-5" {...props} />,
  ol: (props) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5" {...props} />,
  li: (props) => <li className="leading-snug" {...props} />,
  strong: (props) => <strong className="font-semibold text-stone-900" {...props} />,
  em: (props) => <em className="text-stone-700" {...props} />,
  table: (props) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full min-w-fit border-collapse text-xs" {...props} />
    </div>
  ),
  thead: (props) => <thead className="border-b border-stone-300 bg-stone-50" {...props} />,
  th: (props) => (
    <th className="px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-stone-600" {...props} />
  ),
  td: (props) => <td className="border-t border-stone-200 px-2 py-1 align-top" {...props} />,
  code: (props) => (
    <code className="rounded bg-stone-100 px-1 py-px text-[11px] text-stone-800" {...props} />
  ),
  h1: (props) => <h2 className="my-2 text-sm font-bold text-amber-900" {...props} />,
  h2: (props) => <h3 className="my-2 text-sm font-semibold text-amber-900" {...props} />,
  h3: (props) => <h4 className="my-1.5 text-sm font-semibold text-stone-900" {...props} />,
  blockquote: (props) => (
    <blockquote className="my-1.5 border-l-2 border-amber-300 bg-amber-50/60 px-2 py-1 italic" {...props} />
  ),
};

export default function AskBeeves() {
  const [open, setOpen] = useState(false);
  const [thread, setThread] = useState<Turn[]>(cachedThread);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Mirror updates back to module-scope so closing/reopening preserves state.
  useEffect(() => {
    cachedThread = thread;
  }, [thread]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

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
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusy(false);
        abortRef.current = null;
      }
    },
    [busy, thread],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setThread([]);
    setErr(null);
  }, []);

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Ask Beeves"
          title="Ask Beeves — chat with Claude about the stats"
          className="fixed bottom-4 right-4 z-30 inline-flex h-14 w-14 items-center justify-center rounded-full bg-amber-700 text-2xl text-white shadow-lg ring-1 ring-amber-900/20 transition hover:scale-105 hover:bg-amber-800 active:scale-95 sm:bottom-6 sm:right-6 sm:h-16 sm:w-16 sm:text-3xl"
        >
          <span aria-hidden>🐝</span>
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="Ask Beeves"
          className="fixed inset-x-0 bottom-0 z-40 flex max-h-[88vh] flex-col rounded-t-2xl border border-amber-300 bg-white shadow-2xl sm:bottom-6 sm:right-6 sm:left-auto sm:h-[70vh] sm:max-h-[640px] sm:w-[420px] sm:rounded-2xl"
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-2 rounded-t-2xl border-b border-amber-200 bg-amber-50/90 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xl" aria-hidden>🐝</span>
              <div className="leading-tight">
                <div className="text-sm font-semibold text-amber-900">Ask Beeves</div>
                <div className="text-[10px] text-stone-500">Chat with Claude about the stats</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={reset}
                disabled={thread.length === 0 || busy}
                className="rounded-md px-2 py-1 text-xs text-stone-600 hover:bg-stone-100 disabled:opacity-50"
                title="Start a new conversation"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => {
                  abortRef.current?.abort();
                  setOpen(false);
                }}
                aria-label="Close"
                className="rounded-md px-2 py-1 text-lg leading-none text-stone-600 hover:bg-stone-100"
              >
                ×
              </button>
            </div>
          </div>

          {/* Thread */}
          <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
            {thread.length === 0 ? (
              <div className="text-sm text-stone-600">
                <p className="mb-2">Ask anything about the Bumblebeers stats. Try:</p>
                <ul className="space-y-1.5">
                  {SAMPLES.map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        onClick={() => send(s)}
                        className="w-full rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left text-sm text-amber-900 hover:bg-amber-100"
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
                      ? "rounded-lg bg-stone-100 px-2.5 py-2 text-sm text-stone-900"
                      : "rounded-lg border border-amber-100 bg-amber-50/40 px-2.5 py-2 text-sm text-stone-800"
                  }
                >
                  <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                    {t.role === "user" ? "You" : "🐝 Beeves"}
                  </div>
                  {t.role === "user" ? (
                    <p className="whitespace-pre-wrap">{t.content}</p>
                  ) : t.content ? (
                    <div className="text-[13px] text-stone-800">
                      <ReactMarkdown components={MD_COMPONENTS}>{t.content}</ReactMarkdown>
                    </div>
                  ) : (
                    <p className="italic text-stone-500">Thinking…</p>
                  )}
                  {t.meta && t.content && (
                    <div className="mt-1 border-t border-stone-200 pt-1 text-[10px] text-stone-400">
                      {t.meta.input + t.meta.cache_read} in / {t.meta.output} out
                      {t.meta.cache_read > 0 && (
                        <span className="ml-1 text-emerald-700">
                          (cache: {t.meta.cache_read.toLocaleString()})
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
            <div className="mx-3 mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
              {err}
            </div>
          )}

          {/* Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
            className="flex items-end gap-2 border-t border-stone-200 bg-white p-2"
          >
            <textarea
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              placeholder="Ask anything…"
              rows={1}
              disabled={busy}
              className="max-h-32 min-h-9 flex-1 resize-none rounded-md border border-stone-300 px-2 py-1.5 text-sm focus:border-amber-500 focus:outline-none disabled:bg-stone-50"
            />
            <button
              type="submit"
              disabled={!draft.trim() || busy}
              className="rounded-md bg-amber-700 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
            >
              {busy ? "…" : "Send"}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
