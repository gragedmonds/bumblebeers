// Tiny name-matcher: maps a free-text name (e.g. "Sean Ciampaglia") to a
// roster person_key (e.g. "sean") with a confidence score. No fuzzy lib —
// the slo-pitch roster is small (~15 active) and members are well-known.
// Heuristic order:
//   1. exact display_name (case-insensitive)
//   2. first word of input matches display_name
//   3. last word of input matches display_name
//   4. display_name is a token of the input
//   5. display_name is a substring of input
// Anything that doesn't hit one of those is reported as unmatched.

export interface MatchResult {
  raw: string;
  matched: { key: string; display_name: string; reason: string } | null;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchNames(
  inputs: string[],
  roster: { key: string; display_name: string }[],
): MatchResult[] {
  // Build lookup tables once.
  const byDisplay = new Map<string, { key: string; display_name: string }>();
  for (const p of roster) byDisplay.set(norm(p.display_name), p);

  function tryMatch(rawIn: string): MatchResult["matched"] {
    const n = norm(rawIn);
    if (!n) return null;
    // 1. exact display match
    const exact = byDisplay.get(n);
    if (exact) return { ...exact, reason: "exact" };
    const tokens = n.split(" ").filter(Boolean);
    // 2. first word matches a display name
    if (tokens.length) {
      const first = byDisplay.get(tokens[0]);
      if (first) return { ...first, reason: "first-name" };
    }
    // 3. last word matches a display name
    if (tokens.length > 1) {
      const last = byDisplay.get(tokens[tokens.length - 1]);
      if (last) return { ...last, reason: "last-name" };
    }
    // 4. any roster display_name appears as a token
    for (const p of roster) {
      const d = norm(p.display_name);
      if (tokens.includes(d)) return { key: p.key, display_name: p.display_name, reason: "token" };
    }
    // 5. roster display_name is a substring of the input
    for (const p of roster) {
      const d = norm(p.display_name);
      if (d.length >= 3 && n.includes(d)) {
        return { key: p.key, display_name: p.display_name, reason: "substring" };
      }
    }
    return null;
  }

  return inputs.map((raw) => ({ raw, matched: tryMatch(raw) }));
}
