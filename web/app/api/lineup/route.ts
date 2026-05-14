import { NextResponse } from "next/server";
import {
  EMPTY_LINEUP,
  LINEUP_KEY,
  type Lineup,
  getRedis,
  sanitizeLineup,
} from "@/lib/lineup";

export const dynamic = "force-dynamic";

export async function GET() {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(EMPTY_LINEUP, {
      headers: { "x-bb-storage": "unconfigured" },
    });
  }
  const stored = await redis.get<Lineup>(LINEUP_KEY);
  return NextResponse.json(stored ?? EMPTY_LINEUP);
}

export async function PUT(req: Request) {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json(
      { error: "Upstash Redis is not configured. Set KV_REST_API_URL + KV_REST_API_TOKEN." },
      { status: 503 },
    );
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const cleaned = sanitizeLineup(raw);
  await redis.set(LINEUP_KEY, cleaned);
  return NextResponse.json(cleaned);
}
