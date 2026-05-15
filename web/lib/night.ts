// Per-night data: who's in, who's out, plus the two game lineups by inning.
// Persisted in Upstash Redis under one key per date.
//
// Key:   `bumblebeers:night:YYYY-MM-DD`
// Value: PersistedNight (below)
//
// Last-write-wins. Multi-user editing on the same night is out of scope.
// Roster lives in snapshot.json — see lib/data-server.ts.

import { Redis } from "@upstash/redis";
import { POSITIONS, type Pos } from "./lineup";

export type Availability = "in" | "out";

export interface Attendance {
  // person_key → availability for THIS night only (does not affect other nights).
  status: Record<string, Availability>;
  // Names the screenshot named that didn't match any roster entry.
  // Surfaced in the UI so Greg can add them manually or fix an alias.
  unmatched_in: string[];
  unmatched_out: string[];
}

// One inning of one game: position → person_key. Missing = unassigned.
export type InningLineup = Partial<Record<Pos, string>>;

export interface GameLineup {
  // Eight innings, index 0–7 = innings 1–8.
  innings: InningLineup[];
  // Batting order: person_keys in batting order (1, 2, 3, ...). Optional
  // for back-compat — older payloads pre-date the order field. Players
  // listed here may or may not field on a given inning; non-fielders sit
  // in the bottom of the lineup table but still bat.
  batting_order?: string[];
}

export interface PersistedNight {
  date: string; // YYYY-MM-DD
  opponent?: string;
  notes?: string;
  attendance: Attendance;
  // Phase 4d populates these. Empty array = no lineups built yet.
  games: GameLineup[]; // length 0 or 2
  updated_at: string;
}

export function emptyNight(date: string): PersistedNight {
  return {
    date,
    attendance: { status: {}, unmatched_in: [], unmatched_out: [] },
    games: [],
    updated_at: "",
  };
}

export function emptyGameLineup(): GameLineup {
  return { innings: Array.from({ length: 8 }, () => ({} as InningLineup)) };
}

export function nightKey(date: string): string {
  return `bumblebeers:night:${date}`;
}

export function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidDate(s: unknown): s is string {
  return typeof s === "string" && DATE_RE.test(s);
}

export function sanitizeNight(date: string, input: unknown): PersistedNight {
  const base = emptyNight(date);
  if (!input || typeof input !== "object") {
    return { ...base, updated_at: new Date().toISOString() };
  }
  const obj = input as Record<string, unknown>;
  const out: PersistedNight = {
    ...base,
    opponent: typeof obj.opponent === "string" ? obj.opponent.trim() || undefined : undefined,
    notes: typeof obj.notes === "string" ? obj.notes : undefined,
    updated_at: new Date().toISOString(),
  };

  // Attendance
  const att = (obj.attendance ?? {}) as Record<string, unknown>;
  const status: Record<string, Availability> = {};
  const inStatus = att.status as Record<string, unknown> | undefined;
  if (inStatus && typeof inStatus === "object") {
    for (const [k, v] of Object.entries(inStatus)) {
      if (!k) continue;
      if (v === "in" || v === "out") status[k] = v;
    }
  }
  const toStrArr = (x: unknown): string[] =>
    Array.isArray(x)
      ? x.map((s) => String(s).trim()).filter(Boolean).slice(0, 64)
      : [];
  out.attendance = {
    status,
    unmatched_in: toStrArr(att.unmatched_in),
    unmatched_out: toStrArr(att.unmatched_out),
  };

  // Games: 0 or 2, each with exactly 8 innings.
  const rawGames = Array.isArray(obj.games) ? obj.games : [];
  out.games = rawGames.slice(0, 2).map((rg): GameLineup => {
    const innings = (Array.isArray((rg as { innings?: unknown }).innings)
      ? ((rg as { innings: unknown[] }).innings)
      : []
    ).slice(0, 8);
    const padded: InningLineup[] = Array.from({ length: 8 }, () => ({}));
    innings.forEach((inn, i) => {
      if (!inn || typeof inn !== "object") return;
      const row: InningLineup = {};
      for (const [pos, who] of Object.entries(inn as Record<string, unknown>)) {
        if (!(POSITIONS as readonly string[]).includes(pos)) continue;
        const w = String(who ?? "").trim();
        if (!w) continue;
        row[pos as Pos] = w;
      }
      padded[i] = row;
    });
    const game: GameLineup = { innings: padded };
    const orderRaw = (rg as { batting_order?: unknown }).batting_order;
    if (Array.isArray(orderRaw)) {
      const seen = new Set<string>();
      const order: string[] = [];
      for (const v of orderRaw) {
        const s = typeof v === "string" ? v.trim() : "";
        if (!s || seen.has(s)) continue;
        seen.add(s);
        order.push(s);
        if (order.length >= 32) break;
      }
      if (order.length) game.batting_order = order;
    }
    return game;
  });

  return out;
}
