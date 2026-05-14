// Shared types and Redis helpers for the Lineup Notes feature.
// Data lives in Upstash Redis under a single key — last-write-wins.

import { Redis } from "@upstash/redis";

export const POSITIONS = [
  "P",
  "C",
  "1B",
  "2B",
  "SS",
  "3B",
  "LF",
  "LCF",
  "RCF",
  "RF",
] as const;
export type Pos = (typeof POSITIONS)[number];

export type Mark = "none" | "can" | "should";

export interface Lineup {
  // matrix[person_key][position] = mark. Missing keys default to "none".
  matrix: Record<string, Partial<Record<Pos, Mark>>>;
  // Optional per-player free-text notes.
  notes: Record<string, string>;
  // Manual roster overrides:
  //   archived: person_keys explicitly hidden from the active roster (even if
  //             the auto-rule would include them — e.g. regular taking the
  //             year off).
  //   added:    person_keys explicitly added to the active roster — either an
  //             existing player the auto-rule would drop, or a brand-new
  //             player who isn't in the snapshot yet.
  archived: string[];
  added: { key: string; display_name: string }[];
  // ISO-8601 timestamp of the most recent successful PUT.
  updated_at: string;
}

export const EMPTY_LINEUP: Lineup = {
  matrix: {},
  notes: {},
  archived: [],
  added: [],
  updated_at: "",
};

export const LINEUP_KEY = "bumblebeers:lineup";

/**
 * Build a Redis client from `KV_REST_API_URL` + `KV_REST_API_TOKEN`
 * (auto-set when the Vercel Upstash integration is installed). Returns
 * null in environments where the env vars are missing so the route
 * handlers can return a friendly 503 instead of throwing.
 */
export function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export function isValidMark(v: unknown): v is Mark {
  return v === "none" || v === "can" || v === "should";
}

export function isValidPos(v: unknown): v is Pos {
  return typeof v === "string" && (POSITIONS as readonly string[]).includes(v);
}

/**
 * Sanitize a payload coming from PUT into a clean Lineup. Unknown
 * positions and marks are dropped silently; notes are coerced to strings
 * and trimmed.
 */
export function sanitizeLineup(input: unknown): Lineup {
  const out: Lineup = {
    matrix: {},
    notes: {},
    archived: [],
    added: [],
    updated_at: new Date().toISOString(),
  };
  if (!input || typeof input !== "object") return out;
  const obj = input as Record<string, unknown>;
  const matrix = obj.matrix;
  if (matrix && typeof matrix === "object") {
    for (const [pk, raw] of Object.entries(matrix as Record<string, unknown>)) {
      if (!pk || !raw || typeof raw !== "object") continue;
      const row: Partial<Record<Pos, Mark>> = {};
      for (const [pos, mark] of Object.entries(raw as Record<string, unknown>)) {
        if (!isValidPos(pos) || !isValidMark(mark)) continue;
        if (mark === "none") continue; // collapse "none" → absent
        row[pos] = mark;
      }
      if (Object.keys(row).length) out.matrix[pk] = row;
    }
  }
  const notes = obj.notes;
  if (notes && typeof notes === "object") {
    for (const [pk, val] of Object.entries(notes as Record<string, unknown>)) {
      if (!pk) continue;
      const s = String(val ?? "").trim();
      if (s) out.notes[pk] = s;
    }
  }
  // archived: dedupe, drop empty strings, cap to 100 entries.
  if (Array.isArray(obj.archived)) {
    const seen = new Set<string>();
    for (const v of obj.archived as unknown[]) {
      const s = typeof v === "string" ? v.trim() : "";
      if (s && !seen.has(s)) {
        seen.add(s);
        out.archived.push(s);
        if (out.archived.length >= 100) break;
      }
    }
  }
  // added: dedupe by key, drop empties, cap to 100 entries.
  if (Array.isArray(obj.added)) {
    const seen = new Set<string>();
    for (const v of obj.added as unknown[]) {
      if (!v || typeof v !== "object") continue;
      const rec = v as Record<string, unknown>;
      const key = typeof rec.key === "string" ? rec.key.trim() : "";
      const name = typeof rec.display_name === "string" ? rec.display_name.trim() : "";
      if (!key || !name || seen.has(key)) continue;
      seen.add(key);
      out.added.push({ key, display_name: name });
      if (out.added.length >= 100) break;
    }
  }
  return out;
}
