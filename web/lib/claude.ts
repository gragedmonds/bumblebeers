// Shared Anthropic SDK client + model picks.
//
// Server-only — never import this from a client component (it leans on
// process.env.ANTHROPIC_API_KEY, which must never reach the browser).

import "server-only";
import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

/** Lazy-init: avoids touching env at module load (matters at build time). */
export function getAnthropic(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

// Pick once, in one place, so swapping models later is a single edit.
export const MODELS = {
  /** Default for Ask the Bee + general reasoning. Cheaper, fast. */
  default: "claude-sonnet-4-6",
  /** Heavyweight, used when the user asks for "deep" mode. */
  smart: "claude-opus-4-7",
  /** Vision / OCR / structured-extraction — Sonnet handles screenshots well. */
  vision: "claude-sonnet-4-6",
} as const;

export interface ExtractedAttendees {
  in: string[];
  out: string[];
}

export type SupportedImageType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

/**
 * Pull names out of a poll-results screenshot using Claude vision.
 *
 * Expects the team's usual SMS/iMessage poll layout — names bucketed under
 * "In" / "Out" / "Maybe" headers. We surface IN and OUT separately so the
 * UI can show both contexts; MAYBE is folded into "out" (assumed not playing
 * until they confirm otherwise).
 */
export async function extractAttendeesFromImage(
  base64: string,
  mediaType: SupportedImageType,
): Promise<ExtractedAttendees> {
  const a = getAnthropic();
  if (!a) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
  const resp = await a.messages.create({
    model: MODELS.vision,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          {
            type: "text",
            text: [
              "Screenshot of poll results for a slo-pitch game night. Names are bucketed under headers like \"In\", \"Out\", and sometimes \"Maybe\".",
              "",
              "Return STRICT JSON only — no prose, no code fences — with this shape:",
              '{"in":["Name", ...], "out":["Name", ...]}',
              "",
              "Rules:",
              '- A name preceded by "~" (non-contact entry) keeps the rest of the name without the tilde.',
              '- If you see the literal word "You" as a name, include it literally — the caller substitutes their own name.',
              "- Strip phone numbers, timestamps, and any other metadata.",
              '- Fold any "Maybe" names into the "out" array.',
              '- If a section is absent, return an empty array for it.',
              "- Trim whitespace. Preserve original capitalization.",
            ].join("\n"),
          },
        ],
      },
    ],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Claude returned non-JSON: ${text.slice(0, 200)}`);
  }
  const obj = parsed as { in?: unknown; out?: unknown };
  const toArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  return { in: toArr(obj.in), out: toArr(obj.out) };
}
