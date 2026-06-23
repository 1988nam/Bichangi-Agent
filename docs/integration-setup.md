# Integration Setup

## Gemini (요약 두뇌)

The assistant uses Google Gemini to summarize calendar, agent, and news data into a
Korean, importance-sorted briefing.

- Get an API key from Google AI Studio.
- Store it as a Cloudflare secret:

```powershell
npx wrangler secret put GEMINI_API_KEY
```

- Model defaults to `gemini-3.5-flash`; override via the `GEMINI_MODEL` var in
  `wrangler.jsonc`. The client disables "thinking" (`thinkingBudget: 0`) so the whole
  output budget is spent on the visible answer, and auto-falls back to `gemini-2.5-flash`
  if the configured model returns 404.
- Local dev reads the key from `.dev.vars` (gitignored), not from secrets.
- Without the key the Worker still produces a rule-based fallback briefing.

## Agent integration: events (push) + status (pull)

`AGENT_*_URL` point at the agent homepages, which for an SPA are just an empty shell — the
Worker can only detect "the deployed page changed". For meaningful alerts, agents should
publish their real state in one of two ways (you can use both):

### Push — agents send events (real-time)

Agents POST meaningful events to the assistant. `level: "alert"` fires an immediate
KakaoTalk; every event is folded into the next 08:00/16:00 briefing regardless.

Exception: alerts from agents listed in `IMMEDIATE_ALERT_SUPPRESS` (comma-separated;
defaults to `부챙이`, the auto-trading agent) skip the immediate KakaoTalk and only
appear in the next briefing. The response returns `"suppressed": true` for those.
Set `IMMEDIATE_ALERT_SUPPRESS` to an empty string to let every agent alert again.

```
POST https://bichangi-agent.1988nam.workers.dev/api/agent-event
Authorization: Bearer <AGENT_INGEST_TOKEN>
Content-Type: application/json

{ "agent": "부챙이", "level": "alert", "title": "자동매매 오류",
  "detail": "거래소 API 연결 끊김", "items": ["주문 2건 대기"] }
```

- `agent` (required), `title` (required), `level` ("info" | "alert", default info),
  `detail` (optional), `items` (optional string array).
- Minimal client (works from a browser SPA or a server/cron):

```js
fetch("https://bichangi-agent.1988nam.workers.dev/api/agent-event", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer <AGENT_INGEST_TOKEN>" },
  body: JSON.stringify({ agent: "투챙이", level: "info", title: "오늘 매수 신호 2건" }),
});
```

Set the ingest token: `npx wrangler secret put AGENT_INGEST_TOKEN` (it falls back to
`AUTH_TOKEN` if unset). Keep this token out of public client code where possible.

### Pull — agents expose a status endpoint (polled 08:00/16:00)

Each agent exposes a JSON status endpoint (e.g. a Cloudflare Pages Function at
`functions/api/status.js`) and you set `AGENT_TUCHANGI_STATUS_URL` (etc.). When present it
is used instead of the homepage.

```jsonc
// GET <agent>/api/status
{ "status": "ok",        // or "alert" / "error"
  "summary": "보유 3종목 +1.2%, 매수신호 2건",
  "items": ["삼성전자 매수 신호", "SK하이닉스 관심"],
  "level": "info" }      // "alert"/"error"/"warn" → flagged with ⚠️
```

Change detection hashes only `summary`/`items`/`level` (not timestamps), so a ticking
`updatedAt` won't falsely report "변경". `summary` + `items` are surfaced in the briefing.

## Agent URLs

The four Cloudflare Pages agents are configured as Worker variables:

- `AGENT_TUCHANGI_URL=https://toochangi.pages.dev/`
- `AGENT_GACHANGI_URL=https://gachangi.pages.dev/`
- `AGENT_DACHANGI_URL=https://dachangi.pages.dev/`
- `AGENT_BUCHANGI_URL=https://buchangi.pages.dev/`

If the Pages apps require OAuth through the user's local browser session, the Worker cannot reuse that local browser login directly. For serverless background execution, each agent needs one of these:

1. A public or token-protected API endpoint that returns the daily summary.
2. A Cloudflare Worker-to-Worker service binding.
3. A refresh-token based backend endpoint.
4. A Google Drive-backed relay endpoint that writes each agent result to a file the assistant can read.

## Google Calendar

Recommended shape:

- Create a small Google Apps Script or Google Cloud endpoint that reads Calendar and returns JSON.
- Store that endpoint in Cloudflare with:

```powershell
npx wrangler secret put GOOGLE_CALENDAR_ENDPOINT
```

Minimum endpoint response shape:

```json
{
  "events": [
    {
      "summary": "Example event",
      "start": "2026-06-16T09:00:00+09:00",
      "end": "2026-06-16T10:00:00+09:00"
    }
  ],
  "tasks": []
}
```

Google setup notes:

- Enable the Google Calendar API in a Google Cloud project.
- Configure the OAuth consent screen.
- Create OAuth credentials for user-owned Calendar data.
- Use a refresh token or Apps Script web app so the Cloudflare Worker does not need a browser login session.

## Google Drive

Recommended shape:

- Create a Google Apps Script Web App that accepts a POST body and writes `YYYY-MM-DD.json` or `YYYY-MM-DD.md` to a Drive folder.
- Store the Web App URL in Cloudflare with:

```powershell
npx wrangler secret put GOOGLE_DRIVE_REPORT_ENDPOINT
```

The Worker will POST the full report JSON to that endpoint after generating a report.

## KakaoTalk

KakaoTalk is not a simple generic incoming webhook like Slack. For personal alerts, use Kakao Developers "Send to me" Kakao Talk Message API, or create a relay endpoint that accepts this Worker payload:

```json
{
  "text": "short message",
  "report": {}
}
```

If you already want a relay-style endpoint, store that URL in Cloudflare:

```powershell
npx wrangler secret put KAKAO_WEBHOOK_URL
```

Kakao setup notes:

- Create a Kakao Developers app.
- Enable Kakao Login.
- Configure consent for `talk_message`.
- Obtain a refresh token once through the login flow.
- Either send directly with `KAKAO_REST_API_KEY` + `KAKAO_REFRESH_TOKEN`, or use a relay endpoint.

Current Kakao Console path for redirect URI:

1. Open the app in Kakao Developers Console.
2. In the left sidebar, go to `제품 설정 > 카카오 로그인`.
3. Turn Kakao Login on.
4. Find the `Redirect URI` section on that page.
5. Add:

```text
https://bichangi-agent.1988nam.workers.dev/api/kakao/callback
```

The Worker also exposes:

- `GET /api/kakao/login`
- `GET /api/kakao/callback`
- `GET /api/kakao/send-test`

Store the REST API key before using the login endpoint:

```powershell
npx wrangler secret put KAKAO_REST_API_KEY
```

If Kakao app security uses a client secret, store it too:

```powershell
npx wrangler secret put KAKAO_CLIENT_SECRET
```

After that:

1. Visit:

```text
https://bichangi-agent.1988nam.workers.dev/api/kakao/login
```

2. Complete Kakao login and consent.
3. The callback page will show a refresh token.
4. Store it:

```powershell
npx wrangler secret put KAKAO_REFRESH_TOKEN
```

5. Redeploy:

```powershell
npx wrangler deploy --minify
```

6. Verify direct delivery:

```text
https://bichangi-agent.1988nam.workers.dev/api/kakao/send-test
```

If that returns `{"ok": true, "mode": "direct"}`, Kakao delivery is wired correctly.

## Local OAuth Settings

Local OAuth files, browser cookies, and desktop app sessions should not be copied into Worker source or committed to GitHub. If an existing local project already has refresh tokens or credentials, move them into Cloudflare secrets only after confirming the exact variable names and scopes.

Use interactive secret prompts so secret values are not printed:

```powershell
npx wrangler secret put SECRET_NAME
```

Never place OAuth tokens in `wrangler.jsonc`, `.env.example`, README, or source files.
