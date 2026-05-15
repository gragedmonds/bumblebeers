"use client";

// The per-night lineup builder. TRANSPOSED layout: rows = players in
// batting order, columns = innings. Each cell picks a defensive position
// for that player in that inning (or "Sit"). Players can be reordered by
// drag-and-drop on desktop or up/down arrows on touch.
//
// Storage stays "position → player" per inning (InningLineup) so the
// existing API contracts and Claude prompts don't change. The batting
// order is stored per game on `GameLineup.batting_order`.
//
// Constraint enforced live: a position can only be assigned to one player
// per inning. Picking a position that's already taken evicts the prior
// holder for that inning.

import { useCallback, useMemo, useState } from "react";
import {
  POSITIONS_BY_MODE,
  modeForAttendeeCount,
  positionLabel,
  type Lineup,
  type LineupMode,
  type Mark,
  type Pos,
} from "@/lib/lineup";
import type { GameLineup, InningLineup } from "@/lib/night";

interface RosterPlayer {
  key: string;
  display_name: string;
}

interface LineupBuilderProps {
  roster: RosterPlayer[];
  attending: string[]; // person_keys
  prefs: Lineup; // shared can/should matrix
  games: GameLineup[]; // 0 or 2
  opponent?: string | null;
  // When non-null, parent will render a "Print" button targeting this URL.
  // Lives on the parent so the builder doesn't need to know about routing.
  printHref?: string;
  onChange: (next: GameLineup[]) => void;
}

const INNINGS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

function emptyInnings(): InningLineup[] {
  return Array.from({ length: 8 }, () => ({}) as InningLineup);
}

function ensureTwoGames(games: GameLineup[]): GameLineup[] {
  const out: GameLineup[] = [];
  for (let i = 0; i < 2; i++) {
    const g = games[i];
    if (g && Array.isArray(g.innings) && g.innings.length === 8) {
      out.push({
        innings: g.innings.map((row) => ({ ...row })),
        batting_order: Array.isArray(g.batting_order) ? [...g.batting_order] : undefined,
      });
    } else {
      out.push({ innings: emptyInnings() });
    }
  }
  return out;
}

function prefRank(prefs: Lineup, personKey: string, pos: Pos): Mark | "none" {
  return (prefs.matrix[personKey]?.[pos] as Mark | undefined) ?? "none";
}

// Resolve a stable batting order for the given attendees. Anything in the
// stored order that's still attending stays in its position; new attendees
// land at the bottom alphabetically. Drops anyone no longer attending.
function resolveOrder(
  attending: string[],
  stored: string[] | undefined,
  rosterByKey: Map<string, RosterPlayer>,
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
    .sort((a, b) => {
      const na = rosterByKey.get(a)?.display_name ?? a;
      const nb = rosterByKey.get(b)?.display_name ?? b;
      return na.localeCompare(nb);
    });
  out.push(...remaining);
  return out;
}

// Look up which position a player occupies in a given inning, if any.
function posInInning(row: InningLineup, playerKey: string): Pos | null {
  for (const [pos, pk] of Object.entries(row)) {
    if (pk === playerKey) return pos as Pos;
  }
  return null;
}

interface SuggestResponse {
  innings?: InningLineup[];
  explanation?: string;
  model?: string;
  usage?: {
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
  };
  error?: string;
  detail?: string;
  count?: number;
  raw?: string;
}

export default function LineupBuilder({
  roster,
  attending,
  prefs,
  games,
  opponent,
  printHref,
  onChange,
}: LineupBuilderProps) {
  const [activeGame, setActiveGame] = useState(0);
  const [smartBusy, setSmartBusy] = useState(false);
  const [smartErr, setSmartErr] = useState<string | null>(null);
  const [smartResult, setSmartResult] = useState<{
    explanation: string;
    model: string;
    usage: SuggestResponse["usage"];
    gameIdx: number;
  } | null>(null);
  // Drag-and-drop state — the person_key of the row currently being dragged.
  const [dragKey, setDragKey] = useState<string | null>(null);

  const mode: LineupMode = useMemo(
    () => modeForAttendeeCount(attending.length),
    [attending.length],
  );
  const positions = useMemo(() => POSITIONS_BY_MODE[mode], [mode]);

  const ensured = useMemo(() => ensureTwoGames(games), [games]);
  const game = ensured[activeGame];

  const rosterByKey = useMemo(() => {
    const m = new Map<string, RosterPlayer>();
    for (const p of roster) m.set(p.key, p);
    return m;
  }, [roster]);

  const order = useMemo(
    () => resolveOrder(attending, game.batting_order, rosterByKey),
    [attending, game.batting_order, rosterByKey],
  );

  // Innings played per player, current game.
  const inningsPlayed = useMemo(() => {
    const counts = new Map<string, number>();
    game.innings.forEach((row) =>
      Object.values(row).forEach((pk) => {
        if (pk) counts.set(pk, (counts.get(pk) ?? 0) + 1);
      }),
    );
    return counts;
  }, [game]);

  // Set or clear a player's position for a single inning. Evicts whoever
  // previously held that position in the same inning.
  const assign = useCallback(
    (inningIdx: number, playerKey: string, newPos: Pos | null) => {
      const next = ensureTwoGames(ensured);
      const row: InningLineup = { ...next[activeGame].innings[inningIdx] };
      // Drop this player from whatever they currently hold in this inning.
      for (const [pos, pk] of Object.entries(row)) {
        if (pk === playerKey) delete row[pos as Pos];
      }
      if (newPos) {
        // Evict any prior holder of newPos in this inning.
        delete row[newPos];
        row[newPos] = playerKey;
      }
      next[activeGame].innings[inningIdx] = row;
      onChange(next);
    },
    [activeGame, ensured, onChange],
  );

  // Persist a new batting order for the active game.
  const setOrder = useCallback(
    (nextOrder: string[]) => {
      const next = ensureTwoGames(ensured);
      next[activeGame] = { ...next[activeGame], batting_order: nextOrder };
      onChange(next);
    },
    [activeGame, ensured, onChange],
  );

  const moveRow = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (fromIdx === toIdx) return;
      const next = order.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      setOrder(next);
    },
    [order, setOrder],
  );

  const handleClearGame = useCallback(() => {
    const next = ensureTwoGames(ensured);
    next[activeGame] = { innings: emptyInnings(), batting_order: order };
    onChange(next);
  }, [activeGame, ensured, onChange, order]);

  const handleClearBoth = useCallback(() => {
    const next = ensureTwoGames(ensured);
    next[0] = { innings: emptyInnings(), batting_order: next[0].batting_order };
    next[1] = { innings: emptyInnings(), batting_order: next[1].batting_order };
    onChange(next);
  }, [ensured, onChange]);

  async function callSuggest(
    payload: Record<string, unknown>,
  ): Promise<SuggestResponse> {
    const r = await fetch("/api/lineup/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await r.json()) as SuggestResponse;
    if (!r.ok || json.error) {
      const friendly =
        json.error === "anthropic_not_configured"
          ? "Claude API key not set — add ANTHROPIC_API_KEY in Vercel to use Smart fill."
          : json.error === "need_at_least_9_attendees"
            ? `Need at least 9 attendees in the In bucket (have ${json.count}).`
            : json.detail || json.error || `HTTP ${r.status}`;
      throw new Error(friendly);
    }
    if (!json.innings || json.innings.length !== 8) {
      throw new Error("Claude returned an unexpected shape.");
    }
    return json;
  }

  const handleGenerateBoth = useCallback(async () => {
    setSmartBusy(true);
    setSmartErr(null);
    setSmartResult(null);
    try {
      const attendees = attending
        .map((k) => ({ key: k, name: rosterByKey.get(k)?.display_name ?? k }))
        .filter((p) => p.name);
      const sharedBase = {
        attendees,
        prefs: prefs.matrix,
        team_notes: prefs.team_notes ?? "",
        opponent: opponent ?? undefined,
        mode,
      };
      const g1 = await callSuggest({
        ...sharedBase,
        game_num: 1,
        existing: ensured[0].innings,
      });
      const g2 = await callSuggest({
        ...sharedBase,
        game_num: 2,
        prior_game: g1.innings,
        existing: ensured[1].innings,
      });
      const next = ensureTwoGames(ensured);
      next[0] = { innings: g1.innings!, batting_order: next[0].batting_order };
      next[1] = { innings: g2.innings!, batting_order: next[1].batting_order };
      onChange(next);
      const usage = g1.usage && g2.usage
        ? {
            input: g1.usage.input + g2.usage.input,
            output: g1.usage.output + g2.usage.output,
            cache_creation: g1.usage.cache_creation + g2.usage.cache_creation,
            cache_read: g1.usage.cache_read + g2.usage.cache_read,
          }
        : (g1.usage ?? g2.usage);
      setSmartResult({
        explanation: [g1.explanation, g2.explanation]
          .filter((s) => s && s.trim())
          .map((s, i) => `Game ${i + 1}: ${s}`)
          .join("\n"),
        model: g1.model ?? g2.model ?? "",
        usage,
        gameIdx: activeGame,
      });
    } catch (e) {
      setSmartErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSmartBusy(false);
    }
  }, [attending, ensured, mode, onChange, opponent, prefs.matrix, prefs.team_notes, rosterByKey, activeGame]);

  if (attending.length === 0) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-white p-4 text-sm text-stone-600 shadow-sm">
        Mark some players as &ldquo;In&rdquo; in the attendance editor first — the builder picks
        from attendees only.
      </div>
    );
  }
  if (attending.length < 9) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-white p-4 text-sm text-stone-600 shadow-sm">
        Need at least 9 players in the In bucket to build a lineup (have {attending.length}).
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-amber-900">Lineup builder</h2>
        <div className="flex gap-2">
          {[0, 1].map((i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActiveGame(i)}
              className={`min-h-11 rounded-md border px-4 py-2 text-sm font-semibold ${
                activeGame === i
                  ? "border-amber-700 bg-amber-700 text-white"
                  : "border-stone-300 bg-white text-stone-700 hover:bg-stone-100"
              }`}
            >
              Game {i + 1}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <button
          type="button"
          onClick={handleGenerateBoth}
          disabled={smartBusy || attending.length < 9}
          title="Claude reads the team notes and assigns 8 innings respecting your rules — both games at once"
          className="min-h-11 rounded-md bg-amber-700 px-4 py-2 font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
        >
          {smartBusy ? "Bee's buzzing…" : "🐝 Generate both games"}
        </button>
        <button
          type="button"
          onClick={handleClearGame}
          disabled={smartBusy}
          className="min-h-11 rounded-md border border-stone-300 px-3 py-2 hover:bg-stone-100 disabled:opacity-50"
        >
          Clear game
        </button>
        <button
          type="button"
          onClick={handleClearBoth}
          disabled={smartBusy}
          className="min-h-11 rounded-md border border-stone-300 px-3 py-2 hover:bg-stone-100 disabled:opacity-50"
        >
          Clear both
        </button>
        {printHref && (
          <a
            href={printHref}
            target="_blank"
            rel="noopener noreferrer"
            className="min-h-11 rounded-md border border-stone-300 px-3 py-2 hover:bg-stone-100"
            title="Open a print-friendly view of both games"
          >
            Export to PDF
          </a>
        )}
        <span className="ml-auto self-center text-xs text-stone-500">
          {mode === "nine"
            ? `9-player mode · one CF · ${attending.length} in`
            : `10-player mode · ${attending.length} in`}
        </span>
      </div>

      {smartErr && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {smartErr}
        </div>
      )}
      {smartResult && (
        <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2 text-sm text-stone-800">
          <div className="font-semibold text-amber-900">Both games generated 🐝</div>
          {smartResult.explanation && (
            <p className="mt-1 whitespace-pre-wrap">{smartResult.explanation}</p>
          )}
          {smartResult.usage && (
            <div className="mt-1 text-[11px] text-stone-500">
              {smartResult.model} · {smartResult.usage.input + smartResult.usage.cache_read + smartResult.usage.cache_creation} in / {smartResult.usage.output} out
              {smartResult.usage.cache_read > 0 && (
                <span className="ml-1 text-emerald-700">
                  (cache hit: {smartResult.usage.cache_read.toLocaleString()})
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-stone-200">
        <table className="min-w-full text-sm">
          <thead className="bg-amber-50/80 text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="sticky left-0 z-10 bg-amber-50/80 px-2 py-2 text-left">#</th>
              <th className="sticky left-8 z-10 bg-amber-50/80 px-2 py-2 text-left">Player</th>
              {INNINGS.map((i) => (
                <th key={i} className="px-1 py-2 text-center font-semibold">
                  Inn {i}
                </th>
              ))}
              <th className="px-2 py-2 text-center" title="Innings played in the field">IP</th>
            </tr>
          </thead>
          <tbody>
            {order.map((pk, rowIdx) => {
              const name = rosterByKey.get(pk)?.display_name ?? pk;
              const isDragging = dragKey === pk;
              const isDropTarget = dragKey != null && dragKey !== pk;
              return (
                <tr
                  key={pk}
                  draggable
                  onDragStart={(e) => {
                    setDragKey(pk);
                    e.dataTransfer.effectAllowed = "move";
                    // Firefox needs data set to start the drag.
                    e.dataTransfer.setData("text/plain", pk);
                  }}
                  onDragEnd={() => setDragKey(null)}
                  onDragOver={(e) => {
                    if (isDropTarget) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    if (!isDropTarget || !dragKey) return;
                    e.preventDefault();
                    const fromIdx = order.indexOf(dragKey);
                    if (fromIdx >= 0) moveRow(fromIdx, rowIdx);
                    setDragKey(null);
                  }}
                  className={`border-t border-stone-100 ${
                    isDragging ? "opacity-40" : ""
                  } ${isDropTarget ? "hover:bg-amber-50" : ""}`}
                >
                  <td className="sticky left-0 z-10 bg-white px-1 py-1.5 text-center text-xs font-semibold text-stone-500">
                    <div className="flex items-center gap-0.5">
                      <span
                        className="cursor-grab select-none text-stone-400 active:cursor-grabbing"
                        title="Drag to reorder"
                        aria-hidden
                      >
                        ⋮⋮
                      </span>
                      <span className="tabular-nums">{rowIdx + 1}</span>
                    </div>
                  </td>
                  <td className="sticky left-8 z-10 bg-white px-2 py-1.5 font-semibold text-stone-800">
                    <div className="flex items-center gap-1">
                      <span className="flex-1 whitespace-nowrap">{name}</span>
                      <span className="flex flex-col gap-0.5">
                        <button
                          type="button"
                          onClick={() => moveRow(rowIdx, Math.max(0, rowIdx - 1))}
                          disabled={rowIdx === 0}
                          aria-label="Move up"
                          className="rounded px-1 text-[10px] text-stone-400 hover:bg-amber-100 hover:text-amber-900 disabled:opacity-30"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={() => moveRow(rowIdx, Math.min(order.length - 1, rowIdx + 1))}
                          disabled={rowIdx === order.length - 1}
                          aria-label="Move down"
                          className="rounded px-1 text-[10px] text-stone-400 hover:bg-amber-100 hover:text-amber-900 disabled:opacity-30"
                        >
                          ▼
                        </button>
                      </span>
                    </div>
                  </td>
                  {INNINGS.map((inning) => {
                    const inningIdx = (inning as number) - 1;
                    const row = game.innings[inningIdx];
                    const current = posInInning(row, pk);
                    const usedByOthers = new Set(
                      Object.entries(row)
                        .filter(([, owner]) => owner && owner !== pk)
                        .map(([pos]) => pos as Pos),
                    );
                    return (
                      <PositionCell
                        key={`${pk}-${inning}`}
                        value={current}
                        playerKey={pk}
                        positions={positions}
                        usedByOthers={usedByOthers}
                        prefs={prefs}
                        mode={mode}
                        onChange={(p) => assign(inningIdx, pk, p)}
                      />
                    );
                  })}
                  <td className="px-2 py-1.5 text-center tabular-nums">
                    <span
                      className={
                        (inningsPlayed.get(pk) ?? 0) === 0 ? "text-red-600 font-semibold" : "text-stone-700"
                      }
                    >
                      {inningsPlayed.get(pk) ?? 0}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-stone-500">
        Drag <span className="font-mono">⋮⋮</span> or use ▲▼ to reorder the batting lineup. Each cell
        picks the player&apos;s defensive position for that inning — &ldquo;Sit&rdquo; means they
        bat but don&apos;t field. Positions already taken in an inning are hidden from the other rows.
      </p>
    </div>
  );
}

function PositionCell({
  value,
  playerKey,
  positions,
  usedByOthers,
  prefs,
  mode,
  onChange,
}: {
  value: Pos | null;
  playerKey: string;
  positions: readonly Pos[];
  usedByOthers: Set<Pos>;
  prefs: Lineup;
  mode: LineupMode;
  onChange: (pos: Pos | null) => void;
}) {
  const eligible = positions.filter((p) => !usedByOthers.has(p) || p === value);
  return (
    <td className="px-1 py-1 text-center">
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value ? (e.target.value as Pos) : null)}
        className={`min-h-11 w-20 max-w-full rounded-md border bg-white px-1 text-sm ${
          value
            ? "border-amber-400 font-semibold text-stone-900"
            : "border-stone-200 text-stone-400"
        }`}
      >
        <option value="">Sit</option>
        {eligible.map((p) => {
          const mark = prefRank(prefs, playerKey, p);
          return (
            <option key={p} value={p}>
              {positionLabel(p, mode)}
              {mark === "should" ? " ★" : mark === "can" ? " ●" : ""}
            </option>
          );
        })}
      </select>
    </td>
  );
}
