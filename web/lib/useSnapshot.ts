"use client";

import { useEffect, useState } from "react";
import type { Snapshot } from "./data";

let cached: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

function fetchSnapshot(): Promise<Snapshot> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch("/data/snapshot.json", { cache: "force-cache" })
    .then((r) => {
      if (!r.ok) throw new Error(`snapshot.json: ${r.status}`);
      return r.json() as Promise<Snapshot>;
    })
    .then((d) => {
      cached = d;
      inflight = null;
      return d;
    })
    .catch((e) => {
      inflight = null;
      throw e;
    });
  return inflight;
}

export function useSnapshot(): { snapshot: Snapshot | null; error: Error | null } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(cached);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (cached) {
      setSnapshot(cached);
      return;
    }
    fetchSnapshot().then(
      (d) => !cancelled && setSnapshot(d),
      (e) => !cancelled && setError(e),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return { snapshot, error };
}
