// POST /api/lineup/suggest
//
// Body:
//   {
//     attendees:  [{ key, name }],
//     prefs:      Record<person_key, Partial<Record<Pos, "can"|"should">>>,
//     team_notes: string,
//     game_num:   1 | 2,             // 1st or 2nd game of the night
//     opponent?:  string,
//     existing?:  InningLineup[]     // partial fill the user already locked in
//   }
//
// Returns: { innings: InningLineup[8], explanation: string, model, usage }
//
// Calls Claude with prompt caching on the instruction block (stable across
// every suggest request) so per-click cost stays in the cache-read tier.

import { NextResponse } from "next/server";
import { getAnthropic, MODELS } from "@/lib/claude";
import { POSITIONS, type Mark, type Pos } from "@/lib/lineup";
import type { InningLineup } from "@/lib/night";
import type Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface SuggestBody {
  attendees?: { key: string; name: string }[];
  prefs?: Record<string, Partial<Record<Pos, Mark>>>;
  team_notes?: string;
  game_num?: 1 | 2;
  opponent?: string;
  existing?: InningLineup[];
}

const INSTRUCTIONS = `You are filling a slo-pitch softball lineup card. The team plays an 8-inning game with these 10 defensive positions:

  Infield: 1B, 2B, 3B, SS, P, C
  Outfield: LF, LCF, RCF, RF

Hard rules:
  1. In each inning, every position is filled by exactly one player.
  2. In each inning, each player plays AT MOST one position. No one is in two spots at once.
  3. Only players in the supplied attendee list can be assigned.
  4. Use the canonical person_key (not the display name) for every assignment.
  5. If you cannot fill a slot under these rules, leave it null and explain why in the explanation field.

Soft rules (prioritize, in this order, when there's slack):
  a. Honour the team_notes block literally — these are explicit rules from the manager (e.g. "X sits last 2 innings", "If Y pitches, Y pitches all game").
  b. Prefer players marked "should" for a position over "can", and "can" over no preference.
  c. Spread innings across the roster — minimize the max number of innings any single player plays, unless team_notes overrides.
  d. If "existing" assignments are provided, treat them as locked — don't overwrite them.

Output format — return ONE JSON object only, no markdown, no prose outside it:
  {
    "innings": [
      { "1B": "person_key|null", "2B": "...", "3B": "...", "SS": "...", "P": "...", "C": "...",
        "LF": "...", "LCF": "...", "RCF": "...", "RF": "..." },
      ... 8 entries total, one per inning ...
    ],
    "explanation": "1-3 sentences naming the constraints from team_notes you applied and any conflicts you couldn't resolve."
  }`;

export async function POST(req: Request) {
  const anthropic = getAnthropic();
  if (!anthropic) {
    return NextResponse.json(
      { error: "anthropic_not_configured" },
      { status: 503 },
    );
  }

  let body: SuggestBody;
  try {
    body = (await req.json()) as SuggestBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const attendees = (body.attendees ?? []).filter(
    (a): a is { key: string; name: string } =>
      !!a && typeof a.key === "string" && a.key.length > 0 && typeof a.name === "string",
  );
  if (attendees.length < 10) {
    return NextResponse.json(
      { error: "need_at_least_10_attendees", count: attendees.length },
      { status: 400 },
    );
  }
  const prefs = body.prefs ?? {};
  const teamNotes = (body.team_notes ?? "").trim();
  const gameNum = body.game_num === 2 ? 2 : 1;
  const opponent = (body.opponent ?? "").trim() || null;
  const existing = Array.isArray(body.existing) ? body.existing : null;

  // Build a per-attendee summary so the model sees exactly who's available
  // and which positions each one can / should play.
  const attendeeBlock = attendees
    .map((a) => {
      const row = prefs[a.key] || {};
      const should = POSITIONS.filter((p) => row[p] === "should");
      const can = POSITIONS.filter((p) => row[p] === "can");
      const parts: string[] = [`${a.key} (${a.name})`];
      if (should.length) parts.push(`should: ${should.join(",")}`);
      if (can.length) parts.push(`can: ${can.join(",")}`);
      if (!should.length && !can.length) parts.push("no preferences");
      return "  - " + parts.join(" | ");
    })
    .join("\n");

  const existingBlock = existing
    ? "\nExisting locked assignments (do not change):\n" +
      existing
        .map((row, i) => {
          const cells = POSITIONS.map((p) => row[p] ? `${p}=${row[p]}` : null).filter(Boolean);
          return `  Inning ${i + 1}: ${cells.length ? cells.join(", ") : "(empty)"}`;
        })
        .join("\n")
    : "";

  const userPrompt = `Game ${gameNum} of 2${opponent ? ` vs ${opponent}` : ""}.

Attendees (${attendees.length}):
${attendeeBlock}

Team notes:
"""
${teamNotes || "(none — apply soft rules and spread innings evenly)"}
"""${existingBlock}

Generate the 8-inning lineup now.`;

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: INSTRUCTIONS,
      cache_control: { type: "ephemeral" },
    },
  ];

  const model = MODELS.default;
  let raw = "";
  let usage: Anthropic.Usage | null = null;
  try {
    const resp = await anthropic.messages.create({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: userPrompt }],
    });
    for (const block of resp.content) {
      if (block.type === "text") raw += block.text;
    }
    usage = resp.usage;
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: "claude_call_failed", detail },
      { status: 502 },
    );
  }

  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.innings)) {
    return NextResponse.json(
      { error: "claude_returned_invalid_json", raw: raw.slice(0, 400) },
      { status: 502 },
    );
  }

  const attendeeKeys = new Set(attendees.map((a) => a.key));
  const innings: InningLineup[] = [];
  for (let i = 0; i < 8; i++) {
    const src = parsed.innings[i] as Record<string, unknown> | undefined;
    const row: InningLineup = {};
    if (src && typeof src === "object") {
      for (const pos of POSITIONS) {
        const v = src[pos];
        if (typeof v === "string" && v && attendeeKeys.has(v)) {
          row[pos] = v;
        }
      }
    }
    innings.push(row);
  }

  return NextResponse.json({
    innings,
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
    model,
    usage: usage
      ? {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cache_creation: usage.cache_creation_input_tokens ?? 0,
          cache_read: usage.cache_read_input_tokens ?? 0,
        }
      : null,
  });
}

function extractJson(text: string): { innings?: unknown; explanation?: unknown } | null {
  if (!text) return null;
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const m = candidate.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
