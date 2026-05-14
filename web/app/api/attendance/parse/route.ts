// POST /api/attendance/parse
//
// Body: { image_base64: string, image_media_type: "image/png"|"image/jpeg"|... }
//
// Sends the image to Claude vision (via extractAttendeesFromImage), then
// fuzzy-matches the names it sees against our roster (display_names from
// snapshot.json).
//
// Returns:
//   {
//     in:  [{ key, display_name, raw, reason }],   // matched roster hits
//     out: [{ key, display_name, raw, reason }],   // matched out/maybe bucket
//     unmatched_in:  ["raw name strings"],         // Claude saw, roster missed
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
import { matchNames } from "@/lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface ParseBody {
  image_base64?: string;
  image_media_type?: string;
}

const VALID_MEDIA = new Set<SupportedImageType>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function matchBucket(
  names: string[],
  roster: { key: string; display_name: string }[],
) {
  const results = matchNames(names, roster);
  const matched = results
    .filter((r) => r.matched)
    .map((r) => ({
      key: r.matched!.key,
      display_name: r.matched!.display_name,
      raw: r.raw,
      reason: r.matched!.reason,
    }));
  const unmatched = results.filter((r) => !r.matched).map((r) => r.raw);
  return { matched, unmatched };
}

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

  let extracted: { in: string[]; out: string[] };
  try {
    extracted = await extractAttendeesFromImage(data, media);
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    const isMissingKey = detail.includes("ANTHROPIC_API_KEY");
    return NextResponse.json(
      { error: isMissingKey ? "anthropic_not_configured" : "claude_call_failed", detail },
      { status: isMissingKey ? 503 : 502 },
    );
  }

  const roster = await loadRoster();
  const inBucket = matchBucket(extracted.in, roster);
  const outBucket = matchBucket(extracted.out, roster);

  return NextResponse.json({
    in: inBucket.matched,
    out: outBucket.matched,
    unmatched_in: inBucket.unmatched,
    unmatched_out: outBucket.unmatched,
    model: MODELS.vision,
  });
}
