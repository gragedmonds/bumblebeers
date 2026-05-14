"use client";

// The per-night lineup builder. Renders TWO 8-inning grids (one per game),
// each with rows = positions, columns = innings. Each cell picks a player
// from the attending roster.
//
// Constraint enforced live: a player already playing a different position in
// the same inning is removed from the other position-pickers for that inning.
// "Suggest fill" greedy-assigns empty cells, preferring players marked
// "should play" the position, then "can play", then any eligible attendee.

import { useCallback, useMemo, useState } from "react";
import { POSITIONS, type Lineup, type Mark, type Pos } from "@/lib/lineup";
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
  onChange: (next: GameLineup[]) => void;
}

const INNINGS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
type Inning = (typeof INNINGS)[number]; // 1..8

function ensureTwoGames(games: GameLineup[]): GameLineup[] {
  const out: GameLineup[] = [];
  for (let i = 0; i < 2; i++) {
    out.push(
      games[i] && Array.isArray(games[i].innings) && games[i].innings.length === 8
        ? { innings: games[i].innings.map((row) => ({ ...row })) }
        : { innings: Array.from({ length: 8 }, () => ({} as InningLineup)) },
    );
  }
  return out;
}

function prefRank(prefs: Lineup, personKey: string, pos: Pos): Mark | "none" {
  return (prefs.matrix[personKey]?.[pos] as Mark | undefined) ?? "none";
}

// Greedy fill that respects:
//   - attendee set
//   - one-position-per-inning per player
//   - existing assignments (never overwritten)
// Player scoring per slot:
//   - should-play this position: +1000
//   - can-play this position: +500
//   - already played fewer innings overall: bonus inversely proportional to count
function suggestFill(
  game: GameLineup,
  attendees: string[],
  prefs: Lineup,
): GameLineup {
  const innings = game.innings.map((row) => ({ ...row }));
  // Count current innings played per player (across this game only).
  const inningsPlayed = new Map<string, number>();
  innings.forEach((row) =>
    Object.values(row).forEach((pk) => {
      if (pk) inningsPlayed.set(pk, (inningsPlayed.get(pk) ?? 0) + 1);
    }),
  );
  for (let i = 0; i < innings.length; i++) {
    const used = new Set(Object.values(innings[i]).filter(Boolean) as string[]);
    for (const pos of POSITIONS) {
      if (innings[i][pos]) continue;
      // Score every attendee
      const candidates = attendees
        .filter((pk) => !used.has(pk))
        .map((pk) => {
          const mark = prefRank(prefs, pk, pos);
          let score = 0;
          if (mark === "should") score += 1000;
          else if (mark === "can") score += 500;
          // Spread innings — fewer played → higher score
          score += 50 - (inningsPlayed.get(pk) ?? 0) * 10;
          return { pk, score };
        })
        .sort((a, b) => b.score - a.score);
      if (candidates.length === 0) continue;
      const pick = candidates[0].pk;
      innings[i][pos] = pick;
      used.add(pick);
      inningsPlayed.set(pick, (inningsPlayed.get(pick) ?? 0) + 1);
    }
  }
  return { innings };
}

export default function LineupBuilder({
  roster,
  attending,
  prefs,
  games,
  onChange,
}: LineupBuilderProps) {
  const [activeGame, setActiveGame] = useState(0);

  // Make sure we always have exactly 2 games to render. Re-running on every
  // render is fine — it's a couple-of-element copy.
  const ensured = useMemo(() => ensureTwoGames(games), [games]);
  const game = ensured[activeGame];

  const rosterByKey = useMemo(() => {
    const m = new Map<string, RosterPlayer>();
    for (const p of roster) m.set(p.key, p);
    return m;
  }, [roster]);

  // For each attendee, count innings played in the current game — surfaced as
  // a side panel.
  const inningsPlayed = useMemo(() => {
    const counts = new Map<string, number>();
    game.innings.forEach((row) =>
      Object.values(row).forEach((pk) => {
        if (pk) counts.set(pk, (counts.get(pk) ?? 0) + 1);
      }),
    );
    return counts;
  }, [game]);

  const setCell = useCallback(
    (inningIdx: number, pos: Pos, value: string) => {
      const next = ensureTwoGames(ensured);
      const row = { ...next[activeGame].innings[inningIdx] };
      if (!value) delete row[pos];
      else row[pos] = value;
      next[activeGame].innings[inningIdx] = row;
      onChange(next);
    },
    [activeGame, ensured, onChange],
  );

  const handleSuggest = useCallback(() => {
    const next = ensureTwoGames(ensured);
    next[activeGame] = suggestFill(game, attending, prefs);
    onChange(next);
  }, [activeGame, attending, ensured, game, onChange, prefs]);

  const handleClearGame = useCallback(() => {
    const next = ensureTwoGames(ensured);
    next[activeGame] = { innings: Array.from({ length: 8 }, () => ({} as InningLineup)) };
    onChange(next);
  }, [activeGame, ensured, onChange]);

  if (attending.length === 0) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-white p-4 text-sm text-stone-600 shadow-sm">
        Mark some players as &ldquo;In&rdquo; in the attendance editor first — the builder picks
        from attendees only.
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
          onClick={handleSuggest}
          className="min-h-11 rounded-md bg-amber-100 px-4 py-2 font-semibold text-amber-900 hover:bg-amber-200"
        >
          Suggest fill (Game {activeGame + 1})
        </button>
        <button
          type="button"
          onClick={handleClearGame}
          className="min-h-11 rounded-md border border-stone-300 px-3 py-2 hover:bg-stone-100"
        >
          Clear Game {activeGame + 1}
        </button>
      </div>

      <div className="overflow-x-auto rounded-md border border-stone-200">
        <table className="min-w-full text-sm">
          <thead className="bg-amber-50/80 text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="sticky left-0 z-10 bg-amber-50/80 px-2 py-2 text-left">Pos</th>
              {INNINGS.map((i) => (
                <th key={i} className="px-1 py-2 text-center font-semibold">
                  Inn {i}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {POSITIONS.map((pos) => (
              <tr key={pos} className="border-t border-stone-100">
                <td className="sticky left-0 z-10 bg-white px-2 py-1.5 font-semibold text-stone-800">
                  {pos}
                </td>
                {INNINGS.map((inning) => {
                  const inningIdx = (inning as number) - 1;
                  const row = game.innings[inningIdx];
                  const current = row[pos] ?? "";
                  // Players assigned to other positions in this inning are
                  // disqualified — they can't play two spots at once.
                  const usedElsewhere = new Set(
                    POSITIONS.filter((p) => p !== pos).map((p) => row[p]).filter(Boolean) as string[],
                  );
                  // Eligible candidates: attending, not playing elsewhere this inning.
                  const candidates = attending
                    .filter((pk) => !usedElsewhere.has(pk))
                    .map((pk) => {
                      const mark = prefRank(prefs, pk, pos);
                      return {
                        pk,
                        name: rosterByKey.get(pk)?.display_name ?? pk,
                        mark,
                      };
                    })
                    .sort((a, b) => {
                      const w = (m: Mark | "none") => (m === "should" ? 0 : m === "can" ? 1 : 2);
                      const dw = w(a.mark) - w(b.mark);
                      return dw !== 0 ? dw : a.name.localeCompare(b.name);
                    });
                  return (
                    <PositionCell
                      key={`${pos}-${inning}`}
                      value={current}
                      candidates={candidates}
                      onChange={(v) => setCell(inningIdx, pos, v)}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
          Innings played (Game {activeGame + 1})
        </h3>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {attending.map((pk) => {
            const name = rosterByKey.get(pk)?.display_name ?? pk;
            const n = inningsPlayed.get(pk) ?? 0;
            return (
              <li key={pk} className="text-stone-700">
                {name}: <b className={n === 0 ? "text-red-600" : "text-stone-900"}>{n}</b>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function PositionCell({
  value,
  candidates,
  onChange,
}: {
  value: string;
  candidates: { pk: string; name: string; mark: Mark | "none" }[];
  onChange: (v: string) => void;
}) {
  // Make sure the currently-selected player is in the dropdown even if they
  // got filtered out (e.g. you re-marked them OUT mid-edit).
  const hasCurrent = value === "" || candidates.some((c) => c.pk === value);
  return (
    <td className="px-1 py-1 text-center">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`min-h-11 w-28 max-w-full rounded-md border bg-white px-1 text-sm ${
          value
            ? "border-amber-400 font-semibold text-stone-900"
            : "border-stone-200 text-stone-400"
        }`}
      >
        <option value="">—</option>
        {!hasCurrent && (
          <option value={value} disabled>
            {value} (unavailable)
          </option>
        )}
        {candidates.map((c) => (
          <option key={c.pk} value={c.pk}>
            {c.name}
            {c.mark === "should" ? " ★" : c.mark === "can" ? " ●" : ""}
          </option>
        ))}
      </select>
    </td>
  );
}
