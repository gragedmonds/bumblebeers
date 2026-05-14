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

export interface MatchedName {
  /** Roster person_key Claude matched to, or null if Claude couldn't resolve. */
  key: string | null;
  /** The raw text Claude saw on the screenshot (e.g. "Tyler Miehe"). */
  raw: string;
}

export interface ExtractedAttendees {
  in: MatchedName[];
  out: MatchedName[];
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
  roster: { key: string; display_name: string }[],
  selfKey?: string | null,
): Promise<ExtractedAttendees> {
  const a = getAnthropic();
  if (!a) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
  // Roster goes into the prompt so Claude can resolve "Tyler Miehe" → "ty"
  // and "Michael Zuliani" → "mikey" without us needing a hardcoded nickname
  // table.
  const rosterBlock = roster
    .map((r) => `  ${r.key} = ${r.display_name}`)
    .join("\n");
  const selfLine = selfKey
    ? `\nThe literal name "You" in the screenshot refers to "${selfKey}".`
    : "";

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
              "Team roster (canonical key on the left, display name on the right):",
              rosterBlock,
              selfLine,
              "",
              "For each name on the screenshot, MATCH it to a roster key. The screenshot may show full names (\"Tyler Miehe\"), nicknames (\"Mikey\"), or first names only — pick the roster key that's clearly the same person. Common nickname/full-name pairs to be aware of (these are typical, not exhaustive):",
              "  - Michael / Mike / Mikey",
              "  - Tyler / Ty",
              "  - David / Dave / Davey",
              "  - Jonathan / Jon / Johnny",
              "  - Christopher / Chris",
              "  - Robert / Rob / Bob",
              "  - Matthew / Matt",
              "  - Last names often appear alongside first names; the first name is usually enough to match.",
              "",
              "Return STRICT JSON only — no prose, no code fences — with this shape:",
              '{"in":[{"key":"ty","raw":"Tyler Miehe"}, ...], "out":[{"key":null,"raw":"Some Stranger"}, ...]}',
              "",
              "Rules:",
              '- Strip phone numbers, timestamps, and any other metadata.',
              '- A leading "~" on a name is a contact-not-saved marker — drop the tilde.',
              '- Fold any "Maybe" names into the "out" array.',
              '- If a section is absent, return an empty array for it.',
              "- If a name on the screenshot does NOT match anyone in the roster, set key to null and include the raw text. Do not invent matches.",
              "- If the same name appears more than once, include it once.",
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
  const validKeys = new Set(roster.map((r) => r.key));
  const toMatched = (v: unknown): MatchedName[] => {
    if (!Array.isArray(v)) return [];
    const seen = new Set<string>();
    const out: MatchedName[] = [];
    for (const item of v) {
      let key: string | null = null;
      let raw = "";
      if (typeof item === "string") {
        raw = item.trim();
      } else if (item && typeof item === "object") {
        const rec = item as Record<string, unknown>;
        if (typeof rec.key === "string" && validKeys.has(rec.key)) key = rec.key;
        if (typeof rec.raw === "string") raw = rec.raw.trim();
      }
      if (!raw) continue;
      const dedupeId = key ?? `__raw__${raw.toLowerCase()}`;
      if (seen.has(dedupeId)) continue;
      seen.add(dedupeId);
      out.push({ key, raw });
    }
    return out;
  };
  return { in: toMatched(obj.in), out: toMatched(obj.out) };
}
