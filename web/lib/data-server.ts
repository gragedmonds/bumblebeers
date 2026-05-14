// Server-side snapshot loader. The Next.js client uses fetch + useSnapshot;
// route handlers can read the same file directly off disk via Node fs.

import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Snapshot } from "./data";

let cached: Snapshot | null = null;

export async function loadSnapshot(): Promise<Snapshot> {
  if (cached) return cached;
  const file = path.join(process.cwd(), "public", "data", "snapshot.json");
  const raw = await fs.readFile(file, "utf-8");
  cached = JSON.parse(raw) as Snapshot;
  return cached;
}

/** Roster derived from the snapshot — every player we've ever tracked. */
export async function loadRoster(): Promise<{ key: string; display_name: string }[]> {
  const snap = await loadSnapshot();
  return Object.entries(snap.players)
    .map(([key, p]) => ({ key, display_name: p.display_name || key }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}
