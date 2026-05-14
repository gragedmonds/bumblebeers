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

// Slo-pitch lineup mode:
//   "ten": classic 10-player alignment (4 OF: LF, LCF, RCF, RF)
//   "nine": short-handed 9-player alignment (3 OF: LF + 1 CF + RF). LCF is
//          reused as the canonical "CF" position so storage stays uniform.
export type LineupMode = "ten" | "nine";

export const POSITIONS_BY_MODE: Record<LineupMode, Pos[]> = {
  ten: ["1B", "2B", "3B", "SS", "P", "C", "LF", "LCF", "RCF", "RF"],
  nine: ["1B", "2B", "3B", "SS", "P", "C", "LF", "LCF", "RF"],
};

/** Display label for a position in a given mode (LCF reads "CF" in 9-player). */
export function positionLabel(pos: Pos, mode: LineupMode = "ten"): string {
  if (mode === "nine" && pos === "LCF") return "CF";
  return pos;
}

/** Auto-pick mode from attendee count. Anyone ≥10 plays full 10-player. */
export function modeForAttendeeCount(count: number): LineupMode {
  return count >= 10 ? "ten" : "nine";
}

export type Mark = "none" | "can" | "should";

export interface Lineup {
  // matrix[person_key][position] = mark. Missing keys default to "none".
  matrix: Record<string, Partial<Record<Pos, Mark>>>;
  // Shared team-wide notes — free text. Read by Claude during "Smart fill"
  // to interpret rules like "Laser sits last 2 innings" or "Greg pitches all
  // game then Davey next game". Visible to and editable by anyone with the URL.
  team_notes: string;
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
  team_notes: "",
  archived: [],
  added: [],
  updated_at: "",
};

const MAX_NOTES_LEN = 4000;

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
    team_notes: "",
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
  // team_notes — single shared string, capped at MAX_NOTES_LEN to avoid
  // pathological payloads. Accept legacy per-player `notes` map by
  // concatenating its values so nothing is silently lost on migration.
  if (typeof obj.team_notes === "string") {
    out.team_notes = obj.team_notes.trim().slice(0, MAX_NOTES_LEN);
  } else if (obj.notes && typeof obj.notes === "object" && !Array.isArray(obj.notes)) {
    const legacy: string[] = [];
    for (const [pk, val] of Object.entries(obj.notes as Record<string, unknown>)) {
      const s = String(val ?? "").trim();
      if (pk && s) legacy.push(`${pk}: ${s}`);
    }
    out.team_notes = legacy.join("\n").slice(0, MAX_NOTES_LEN);
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
