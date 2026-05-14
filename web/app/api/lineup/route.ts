// GET / PUT the shared lineup-notes matrix.
//
// Storage: Upstash Redis (env vars set by the Vercel integration). When the
// env isn't configured we still return a valid (empty) Lineup body so the UI
// can render — and we signal the state via the `x-bb-storage` header so the
// component can show a "not configured" warning. PUT in that mode fails 503.

import { NextResponse } from "next/server";
import {
  EMPTY_LINEUP,
  LINEUP_KEY,
  type Lineup,
  getRedis,
  sanitizeLineup,
} from "@/lib/lineup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function backendHeader(name: "upstash" | "unconfigured") {
  return { "x-bb-storage": name };
}

export async function GET() {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(EMPTY_LINEUP, { headers: backendHeader("unconfigured") });
  }
  try {
    const stored = await redis.get<Lineup>(LINEUP_KEY);
    return NextResponse.json(stored ?? EMPTY_LINEUP, { headers: backendHeader("upstash") });
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ...EMPTY_LINEUP, error: "redis_get_failed", detail },
      { status: 500, headers: backendHeader("upstash") },
    );
  }
}

export async function PUT(req: Request) {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: "upstash_not_configured" },
      { status: 503, headers: backendHeader("unconfigured") },
    );
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const clean = sanitizeLineup(payload);
  try {
    await redis.set(LINEUP_KEY, clean);
    return NextResponse.json(clean, { headers: backendHeader("upstash") });
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "redis_set_failed", detail },
      { status: 500, headers: backendHeader("upstash") },
    );
  }
}
