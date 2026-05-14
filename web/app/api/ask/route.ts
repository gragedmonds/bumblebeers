// POST /api/ask
//
// Streams a Claude response back to the browser as Server-Sent Events.
// The system prompt has the BMBL stats baked in with a single
// `cache_control` breakpoint at the end — first request writes the cache
// (~1.25× write premium), every subsequent request reads it at ~0.1×.
//
// Body: { question: string, history?: {role: "user"|"assistant", content: string}[] }
//
// SSE event types:
//   event: text   data: {"delta": "..."}            — token chunk
//   event: done   data: {"usage": {...}, "model": "..."}  — stream ended cleanly
//   event: error  data: {"error": "...", "detail": "..."} — fatal error

import { NextResponse } from "next/server";
import { getAnthropic, MODELS } from "@/lib/claude";
import { buildAskDataBlock, instructions } from "@/lib/ask-prompt";
import type Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface AskBody {
  question?: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

const MAX_HISTORY_TURNS = 12; // 6 exchanges; keeps tokens bounded
const MAX_QUESTION_LEN = 4000;

export async function POST(req: Request) {
  const anthropic = getAnthropic();
  if (!anthropic) {
    return NextResponse.json(
      { error: "anthropic_not_configured" },
      { status: 503 },
    );
  }

  let body: AskBody;
  try {
    body = (await req.json()) as AskBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const question = (body.question ?? "").trim();
  if (!question) {
    return NextResponse.json({ error: "empty_question" }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LEN) {
    return NextResponse.json({ error: "question_too_long" }, { status: 413 });
  }

  const model = MODELS.default;

  // Clip + sanitise conversation history. Roles must alternate and start with "user".
  const history = (body.history ?? [])
    .slice(-MAX_HISTORY_TURNS)
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0,
    );

  const { text: dataBlock } = await buildAskDataBlock();

  // The two-block system: instructions first (small, frozen), data second
  // (large, frozen). Cache breakpoint on the LAST block covers everything
  // earlier in the prefix per the prompt-cache prefix-match invariant.
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: instructions() },
    {
      type: "text",
      text: dataBlock,
      cache_control: { type: "ephemeral" }, // 5-min TTL; bump to "1h" if traffic is sparse
    },
  ];

  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user" as const, content: question },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      try {
        // SDK streaming helper accumulates state and gives us a final message
        // at the end — exactly what we need for the `done` payload.
        const sdkStream = anthropic.messages.stream({
          model,
          max_tokens: 4096,
          system,
          messages,
        });

        for await (const event of sdkStream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            send("text", { delta: event.delta.text });
          }
        }

        const final = await sdkStream.finalMessage();
        send("done", {
          model,
          stop_reason: final.stop_reason,
          usage: {
            input: final.usage.input_tokens,
            output: final.usage.output_tokens,
            cache_creation: final.usage.cache_creation_input_tokens ?? 0,
            cache_read: final.usage.cache_read_input_tokens ?? 0,
          },
        });
      } catch (e: unknown) {
        const detail = e instanceof Error ? e.message : String(e);
        send("error", { error: "claude_stream_failed", detail });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable buffering on any reverse proxy
    },
  });
}
