// POST /api/attendance/parse
//
// Body: { image_base64: string, image_media_type: "image/png"|"image/jpeg"|..., self_key?: string }
//
// Sends the image to Claude vision, which OCRs the names AND matches them to
// our roster keys (including nicknames — "Mikey" → "mikey", "Tyler Miehe" →
// "ty"). The roster is the snapshot roster plus any custom-added entries from
// the saved lineup blob.
//
// Returns:
//   {
//     in:  [{ key, display_name, raw }],
//     out: [{ key, display_name, raw }],
//     unmatched_in:  ["raw name strings"],
//     unmatched_out: ["raw name strings"],
//     model: string,
//   }

import { NextResponse } from "next/server";
import {
  extractAttendeesFromImage,
  MODELS,
  type SupportedImageType,
} from "@/lib/claude";
import { loadRoster } from "@/lib/data-server";
import {
  EMPTY_LINEUP,
  LINEUP_KEY,
  getRedis,
  type Lineup,
} from "@/lib/lineup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface ParseBody {
  image_base64?: string;
  image_media_type?: string;
  /** Optional: which roster key "You" maps to in the screenshot. */
  self_key?: string;
}

const VALID_MEDIA = new Set<SupportedImageType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export async function POST(req: Request) {
  let body: ParseBody;
  try {
    body = (await req.json()) as ParseBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const data = body.image_base64;
  let media = (body.image_media_type || "image/png") as SupportedImageType;
  if (media === ("image/jpg" as SupportedImageType)) media = "image/jpeg";
  if (!data) {
    return NextResponse.json({ error: "missing_image_base64" }, { status: 400 });
  }
  if (!VALID_MEDIA.has(media)) {
    return NextResponse.json({ error: "unsupported_media_type", media }, { status: 400 });
  }
  // 10 MB safety cap on the decoded payload. Most poll screenshots are ~200 KB.
  if (data.length > 14_000_000) {
    return NextResponse.json({ error: "image_too_large" }, { status: 413 });
  }

  // Compose the roster: snapshot players + any custom-added entries from the
  // saved lineup blob. We include archived players too so we never silently
  // mismatch a name on the screenshot — the UI handles filtering.
  const baseRoster = await loadRoster();
  const rosterByKey = new Map<string, string>(
    baseRoster.map((p) => [p.key, p.display_name]),
  );
  const redis = getRedis();
  if (redis) {
    try {
      const stored = await redis.get<Lineup>(LINEUP_KEY);
      const added = (stored ?? EMPTY_LINEUP).added ?? [];
      for (const a of added) {
        if (a.key && !rosterByKey.has(a.key)) {
          rosterByKey.set(a.key, a.display_name);
        }
      }
    } catch {
      // Redis read failure is non-fatal — proceed with the snapshot roster.
    }
  }
  const roster = [...rosterByKey.entries()].map(([key, display_name]) => ({
    key,
    display_name,
  }));

  let extracted: { in: { key: string | null; raw: string }[]; out: { key: string | null; raw: string }[] };
  try {
    extracted = await extractAttendeesFromImage(data, media, roster, body.self_key ?? null);
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    const isMissingKey = detail.includes("ANTHROPIC_API_KEY");
    return NextResponse.json(
      { error: isMissingKey ? "anthropic_not_configured" : "claude_call_failed", detail },
      { status: isMissingKey ? 503 : 502 },
    );
  }

  const bucket = (items: { key: string | null; raw: string }[]) => {
    const matched: { key: string; display_name: string; raw: string }[] = [];
    const unmatched: string[] = [];
    for (const item of items) {
      if (item.key && rosterByKey.has(item.key)) {
        matched.push({
          key: item.key,
          display_name: rosterByKey.get(item.key)!,
          raw: item.raw,
        });
      } else {
        unmatched.push(item.raw);
      }
    }
    return { matched, unmatched };
  };

  const inBucket = bucket(extracted.in);
  const outBucket = bucket(extracted.out);

  return NextResponse.json({
    in: inBucket.matched,
    out: outBucket.matched,
    unmatched_in: inBucket.unmatched,
    unmatched_out: outBucket.unmatched,
    model: MODELS.vision,
  });
}
