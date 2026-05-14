// GET /api/schedule
//
// Scrapes the HTOSports public schedule page for the Bumblebeers, groups the
// game rows into doubleheader-aware "nights", and returns JSON.
//
// Cached for 1 hour via fetch revalidate; HTOSports doesn't change often.

import { NextResponse } from "next/server";
import * as cheerio from "cheerio";
import {
  HTO_URL,
  type NightSchedule,
  type ScheduledGame,
  groupIntoNights,
  normalizeTime,
} from "@/lib/schedule";

export const runtime = "nodejs";
export const revalidate = 3600; // re-scrape at most once an hour

export async function GET() {
  let html: string;
  try {
    const res = await fetch(HTO_URL, {
      headers: {
        "User-Agent": "BumblebeersDashboard/1.0 (+https://github.com/gragedmonds/bumblebeers)",
      },
      next: { revalidate: 3600 },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: "fetch_failed", status: res.status },
        { status: 502 },
      );
    }
    html = await res.text();
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "fetch_failed", detail }, { status: 502 });
  }

  let nights: NightSchedule[];
  try {
    nights = parseHtoSchedule(html);
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "parse_failed", detail }, { status: 500 });
  }

  return NextResponse.json({
    source: HTO_URL,
    fetched_at: new Date().toISOString(),
    nights,
  });
}

function cleanText(s: string): string {
  return s.replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function parseHtoSchedule(html: string): NightSchedule[] {
  const $ = cheerio.load(html);
  const games: ScheduledGame[] = [];

  $("table.scheduleList tbody tr.schedRow.game").each((_, el) => {
    const row = $(el);
    // Date class `schedRowDay_YYYYMMDD` is the most reliable date source.
    const cls = row.attr("class") ?? "";
    const m = cls.match(/schedRowDay_(\d{4})(\d{2})(\d{2})/);
    const date = m ? `${m[1]}-${m[2]}-${m[3]}` : "";

    const time = normalizeTime(cleanText(row.find("td.col_Time").text()));
    const oppRaw = cleanText(row.find("td.col_Opponent").text());
    const homeAway: "home" | "away" = oppRaw.startsWith("@") ? "away" : "home";
    const opponent = oppRaw
      .replace(/^@\s*/, "")
      .replace(/^vs\.?\s*/i, "")
      .trim();
    const score = cleanText(row.find("td.col_Score").text()) || null;
    const location = cleanText(row.find("td.col_Location").text());

    const href = row.find("td.col_Details a").attr("href") ?? "";
    const idMatch = href.match(/gameID=(\d+)/);
    const gameId = idMatch ? idMatch[1] : null;

    if (!date) return; // skip header / malformed rows
    games.push({ date, time, opponent, location, homeAway, score, gameId });
  });

  return groupIntoNights(games);
}
