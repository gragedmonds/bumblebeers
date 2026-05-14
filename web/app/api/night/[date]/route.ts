// GET / PUT a per-night data blob (attendance + game lineups). One Redis key
// per date: `bumblebeers:night:YYYY-MM-DD`.

import { NextResponse } from "next/server";
import {
  emptyNight,
  getRedis,
  isValidDate,
  nightKey,
  sanitizeNight,
  type PersistedNight,
} from "@/lib/night";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ date: string }> }) {
  const { date } = await ctx.params;
  if (!isValidDate(date)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      { night: emptyNight(date), error: "upstash_not_configured" },
      { status: 503 },
    );
  }
  try {
    const stored = await redis.get<PersistedNight>(nightKey(date));
    return NextResponse.json({ night: stored ?? emptyNight(date) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { night: emptyNight(date), error: "redis_get_failed", detail: msg },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ date: string }> }) {
  const { date } = await ctx.params;
  if (!isValidDate(date)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: "upstash_not_configured" }, { status: 503 });
  }
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const clean = sanitizeNight(date, payload);
  try {
    await redis.set(nightKey(date), clean);
    return NextResponse.json({ night: clean });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "redis_set_failed", detail: msg },
      { status: 500 },
    );
  }
}
