# Bichangi Agent

LangGraph format assistant project. The first graph asks focused questions, stores the answers in state, and produces an implementation brief for the real assistant.

The deployment target is Cloudflare Workers with API routes and static dashboard assets in one serverless app.

## Question graph

```mermaid
flowchart TD
    START([START]) --> purpose[ask_purpose]
    purpose --> audience[ask_audience]
    audience --> tools[ask_tools]
    tools --> memory[ask_memory]
    memory --> interface[ask_interface]
    interface --> safety[ask_safety]
    safety --> brief[build_brief]
    brief --> END([END])
```

## Daily run graph

```mermaid
flowchart TD
    START([START]) --> config[load_config]
    config --> calendar[collect_calendar]
    calendar --> agents[run_agents]
    agents --> news[collect_news]
    news --> memory[update_memory]
    memory --> report[build_daily_report]
    report --> delivery[deliver_report]
    delivery --> END([END])
```

## Run later

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
copy .env.example .env
codex-secretary run-daily
codex-secretary web
```

The current requirements are stored in `docs/assistant-spec.md` and summarized in `docs/build-brief.md`.

## Run without installing

Codex Desktop includes a bundled Python runtime. You can run the current mock workflow directly:

```powershell
$env:PYTHONPATH='src'
& 'C:\Users\1988n\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m codex_secretary.cli run-daily
& 'C:\Users\1988n\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m codex_secretary.cli web
```

The generated report is written to `data/reports/YYYY-MM-DD.md`, and the dashboard reads `data/latest_report.json`.

## Cloudflare Worker

Serverless BE/FE source lives in:

- `worker/index.ts` for API routes and scheduled daily execution.
- `public/` for the local dashboard UI.
- `wrangler.jsonc` for Cloudflare Workers deployment config.

Local/dev commands after installing Node dependencies:

```powershell
npm install
npm run check
npm run dev
npm run deploy:dry-run
npm run deploy
```

### Architecture (worker/)

The Worker is split into focused modules:

- `index.ts` — HTTP router + cron `scheduled` handler.
- `report.ts` — orchestrator. Gathers calendar + agents + news, asks Gemini for an
  importance-sorted Korean briefing (with a deterministic fallback), updates memory,
  saves to KV, and delivers via Kakao.
- `gemini.ts` — Google Gemini REST client (`x-goog-api-key`, `thinkingBudget: 0`,
  auto-fallback model on 404).
- `feed.ts` — dependency-free RSS/Atom parser (Workers has no DOMParser).
- `news.ts` / `calendar.ts` / `agents.ts` — connectors (RSS filter+rank, calendar JSON
  parse, agent change-detection by content hash).
- `kakao.ts` — OAuth + send (clamped to Kakao's 200-char text limit).
- `storage.ts` — KV-backed latest report, daily history, and memory.
- `diagnostics.ts` — `/api/diagnostics` self-check for every integration.

### The brain: Gemini

The assistant summarizes in Korean with Google Gemini. Set the key (model defaults to
`gemini-3.5-flash`, override with the `GEMINI_MODEL` var):

```powershell
npx wrangler secret put GEMINI_API_KEY
```

For local `wrangler dev`, put it in `.dev.vars` (gitignored) instead:

```text
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash
```

If `GEMINI_API_KEY` is absent the assistant still runs, falling back to a rule-based
summary (flagged as `generatedBy: "fallback"`).

### Persistent storage (KV)

Memory (news keywords, excluded topics, RSS sources, per-agent history, unfinished tasks)
and the latest/daily reports live in a KV namespace bound as `REPORTS`:

```powershell
npx wrangler kv namespace create REPORTS
# paste the printed id into wrangler.jsonc "kv_namespaces"
```

### API routes

- `GET /api/health`
- `GET /api/report/latest` — stored briefing (generates one on first call)
- `POST /api/report/run` — gather + summarize + deliver + store
- `GET /api/report/history` — recent daily report keys
- `GET /api/report/YYYY-MM-DD` — a specific stored report
- `GET /api/diagnostics` (`?live=1` to really call Gemini/Kakao) — is everything wired?
- `GET /api/memory` / `POST /api/memory` — read/update keywords, excluded topics, RSS
- `GET /api/kakao/login` · `GET /api/kakao/callback` · `GET /api/kakao/send-test`

### Access control

The Worker is deployed at a public URL, so set a shared secret to gate the
mutating/side-effecting API (everything except `/api/health` and the Kakao OAuth
redirects):

```powershell
npx wrangler secret put AUTH_TOKEN
```

When `AUTH_TOKEN` is set, the dashboard prompts for it once (stored in
`localStorage`) and sends it as `Authorization: Bearer <token>`. Server-side fetch
targets (RSS/calendar/agents) are also validated to block private/loopback hosts
(SSRF). If `AUTH_TOKEN` is unset the API stays open and `/api/diagnostics` flags it.

Secrets / vars to add for full functionality:

```powershell
npx wrangler secret put AUTH_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put KAKAO_REST_API_KEY
npx wrangler secret put KAKAO_CLIENT_SECRET
npx wrangler secret put KAKAO_REFRESH_TOKEN
npx wrangler secret put KAKAO_WEBHOOK_URL
npx wrangler secret put GOOGLE_DRIVE_REPORT_ENDPOINT
npx wrangler secret put GOOGLE_CALENDAR_ENDPOINT
npx wrangler secret put NEWS_RSS_URLS
npx wrangler secret put NEWS_SEARCH_ENDPOINT
# Optional real agent status APIs (otherwise homepage change-detection is used):
npx wrangler secret put AGENT_TUCHANGI_STATUS_URL
npx wrangler secret put AGENT_GACHANGI_STATUS_URL
npx wrangler secret put AGENT_DACHANGI_STATUS_URL
npx wrangler secret put AGENT_BUCHANGI_STATUS_URL
```

> Note: `worker/` is the live product. The `src/codex_secretary/` Python files are an
> earlier mock-only prototype kept for reference; they are not part of the deployment.

See `docs/integration-setup.md` for Google Calendar, Google Drive, KakaoTalk, and OAuth setup notes.

To set secrets interactively without printing values:

```powershell
.\scripts\set-secrets.ps1
```

The final source remote should be `https://github.com/1988nam/Bichangi-Agent`.
