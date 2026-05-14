# Bumblebeers

Adult slo-pitch analytics: BMBL+ rankings, animated spray charts, Tall-Can MVP picker,
lineup planning, and a Claude-powered Q&A. Public team dashboard for the
**2025 Summer Bumblebeers**.

| Tab | What it does |
|---|---|
| **Trends** | Season-by-season BMBL+ scores, leaderboards, component breakdowns |
| **Diamond** | Animated spray chart — every at-bat. Runner-on-base dots + run-scoring flash (coming Phase 3) |
| **🍺 MVP** | Per-night Tall-Can recipient picker |
| **Lineup** | Per-player × per-position can-play / should-play grid (team-shared) |
| **Ask the Bee** | Natural-language Q&A over the stats, powered by Claude |

## Repo layout

```
bumblebeers/
├── build_excel.py             # raw JSON → multi-sheet workbook
├── build_rankings.py          # BMBL+ score computation
├── build_data_json.py         # (Phase 2) emits web/public/data/snapshot.json
├── gamechanger_bumblebeers_raw.json
├── gamechanger_season_stats.json
├── BMBL_PLUS_PROPOSAL.md
├── CLAUDE.md                  # full project context for agentic editors
└── web/                       # Next.js 16 app (App Router), deployed to Vercel
    ├── app/                   # pages + route handlers
    ├── public/data/           # snapshot.json (regenerated when re-scraping)
    └── …
```

## Local dev

```bash
# 1. Python pipeline (only when re-scraping)
python build_excel.py
python build_rankings.py
python build_data_json.py        # writes web/public/data/snapshot.json

# 2. Web app
cd web
npm install
npm run dev                      # http://localhost:3000
```

## Deploy

Vercel project root = `web/`. Push to `main` → auto-deploy.

Env vars to set in Vercel:

| Var | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Ask the Bee (Claude API) |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Lineup Notes persistence (Upstash Redis) |

## Re-scraping after new games

GameChanger has no public API. See [CLAUDE.md](CLAUDE.md) for the manual
in-browser scrape flow, then commit the regenerated JSON and Vercel auto-deploys.
