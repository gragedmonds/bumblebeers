// Types + helpers for the league schedule scraped from HTOSports.
//
// One "night" usually has two games (doubleheader). We group adjacent games on
// the same date into a single night.

export interface ScheduledGame {
  date: string; // YYYY-MM-DD (Toronto-local)
  time: string; // "7:30 PM"
  opponent: string;
  location: string;
  homeAway: "home" | "away";
  score: string | null;
  gameId: string | null;
}

export interface NightSchedule {
  date: string; // YYYY-MM-DD
  day: string; // "Wednesday"
  opponent: string;
  location: string;
  games: ScheduledGame[];
}

// HTOSports URL for the Bumblebeers 2026 season. If the team moves leagues or
// the season rolls over, update this and (later) make it env-configurable.
export const HTO_URL =
  "https://www.htosports.com/teams/default.asp?u=YRMSPL&s=softball&p=schedule&div=1027186";

const WEEKDAY: Record<string, string> = {
  Sun: "Sunday",
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
};

/** "Wed, 5/13/26" → "Wednesday". Returns "" if not parseable. */
export function parseWeekday(raw: string): string {
  const m = raw.match(/^([A-Za-z]{3,})/);
  if (!m) return "";
  const k = m[1].slice(0, 3);
  return WEEKDAY[k] ?? "";
}

/** "  7:30 pm " → "7:30 PM". Returns "" if not parseable. */
export function normalizeTime(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").replace(/ /g, " ").trim();
  const m = cleaned.match(/^(\d{1,2}):(\d{2})\s*([ap]m)/i);
  if (!m) return cleaned;
  return `${m[1]}:${m[2]} ${m[3].toUpperCase()}`;
}

/** Group a flat list of games by date into Night objects. */
export function groupIntoNights(games: ScheduledGame[]): NightSchedule[] {
  const byDate = new Map<string, ScheduledGame[]>();
  for (const g of games) {
    const list = byDate.get(g.date) ?? [];
    list.push(g);
    byDate.set(g.date, list);
  }
  const out: NightSchedule[] = [];
  for (const [date, list] of byDate.entries()) {
    list.sort((a, b) => a.time.localeCompare(b.time));
    // Some nights have games against multiple opponents (rare); we report the
    // first one as the "headline" but include all games in the list.
    const dayLabel = parseWeekday(rawWeekdayFromIsoDate(date));
    out.push({
      date,
      day: dayLabel,
      opponent: list[0].opponent,
      location: list[0].location,
      games: list,
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/** YYYY-MM-DD → "Wed" (or whatever; falls back to JS Date). */
function rawWeekdayFromIsoDate(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  if (Number.isNaN(d.getTime())) return "";
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
}
