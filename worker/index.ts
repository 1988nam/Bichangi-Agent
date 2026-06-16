type AppEnv = Cloudflare.Env & {
  KAKAO_WEBHOOK_URL?: string;
  GOOGLE_DRIVE_REPORT_ENDPOINT?: string;
  GOOGLE_CALENDAR_ENDPOINT?: string;
  AGENT_TUCHANGI_URL?: string;
  AGENT_GACHANGI_URL?: string;
  AGENT_DACHANGI_URL?: string;
  AGENT_BUCHANGI_URL?: string;
  NEWS_RSS_URLS?: string;
  NEWS_SEARCH_ENDPOINT?: string;
};

type DeliveryState = "pending" | "sent" | "skipped" | "failed";

interface ConnectorItem {
  label: string;
  status: "mock" | "ok" | "failed";
  detail: string;
}

interface ReportSection {
  title: string;
  items: ConnectorItem[];
}

interface DailyReport {
  id: string;
  date: string;
  generatedAt: string;
  timezone: string;
  summary: string;
  sections: ReportSection[];
  delivery: {
    kakao: DeliveryState;
    dashboard: "ready";
    googleDrive: DeliveryState;
  };
}

interface AgentTarget {
  name: string;
  url?: string;
}

const TEXT_LIMIT_BYTES = 24_000;

const MESSAGES = {
  summary: "\uc77c\uc815/\ud560 \uc77c, Agent \uc5c5\ub370\uc774\ud2b8, \uc624\ub298 \ub274\uc2a4 \uc694\uc57d",
  scheduleTitle: "\uc77c\uc815/\ud560 \uc77c",
  agentTitle: "Agent \uc5c5\ub370\uc774\ud2b8",
  newsTitle: "\uc624\ub298 \ub274\uc2a4",
  kakaoTitle: "\ube44\uc11c \uc694\uc57d",
  googleCalendarPending: "Google Calendar endpoint \uc5f0\uacb0 \ub300\uae30 \uc911",
  googleCalendarReady: "Google Calendar \uc751\ub2f5 \uc218\uc2e0",
  googleCalendarFailed: "Google Calendar \uc218\uc9d1 \uc2e4\ud328",
  agentPending: "\ubc31\uadf8\ub77c\uc6b4\ub4dc \uc2e4\ud589 URL \uc5f0\uacb0 \ub300\uae30 \uc911",
  agentReady: "Agent \uc2e4\ud589 \uacb0\uacfc \uc218\uc2e0",
  agentFailed: "Agent \uc2e4\ud589 \uc2e4\ud328",
  newsPending: "\uc6f9 \uac80\uc0c9/RSS \uc5f0\uacb0 \ub300\uae30 \uc911",
  newsReady: "\ub274\uc2a4 \uc18c\uc2a4 \uc751\ub2f5 \uc218\uc2e0",
  newsFailed: "\ub274\uc2a4 \uc218\uc9d1 \uc2e4\ud328"
};

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

function getKoreanDate(timezone: string, now = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(now);
}

async function readLimitedText(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (received < TEXT_LIMIT_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) {
      break;
    }
    const remaining = TEXT_LIMIT_BYTES - received;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    chunks.push(chunk);
    received += chunk.byteLength;
  }

  await reader.cancel().catch(() => undefined);
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
}

function trimDetail(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 280 ? `${compact.slice(0, 280)}...` : compact;
}

async function fetchConnector(label: string, url: string, ready: string, failed: string): Promise<ConnectorItem> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json, text/plain, application/xml, text/xml;q=0.9, */*;q=0.5" }
    });
    const text = await readLimitedText(response);
    return {
      label,
      status: response.ok ? "ok" : "failed",
      detail: response.ok ? `${ready}: ${trimDetail(text)}` : `${failed}: HTTP ${response.status}`
    };
  } catch (error) {
    return {
      label,
      status: "failed",
      detail: `${failed}: ${String(error)}`
    };
  }
}

async function collectCalendar(env: AppEnv): Promise<ReportSection> {
  const items = env.GOOGLE_CALENDAR_ENDPOINT
    ? [
        await fetchConnector(
          "Google Calendar",
          env.GOOGLE_CALENDAR_ENDPOINT,
          MESSAGES.googleCalendarReady,
          MESSAGES.googleCalendarFailed
        )
      ]
    : [
        {
          label: "Google Calendar",
          status: "mock" as const,
          detail: MESSAGES.googleCalendarPending
        }
      ];

  return { title: MESSAGES.scheduleTitle, items };
}

async function runAgents(env: AppEnv): Promise<ReportSection> {
  const targets: AgentTarget[] = [
    { name: "\ud22c\ucc59\uc774", url: env.AGENT_TUCHANGI_URL },
    { name: "\uac00\ucc59\uc774", url: env.AGENT_GACHANGI_URL },
    { name: "\ub2e4\ucc59\uc774", url: env.AGENT_DACHANGI_URL },
    { name: "\ubd80\ucc59\uc774", url: env.AGENT_BUCHANGI_URL }
  ];

  const items = await Promise.all(
    targets.map((target) =>
      target.url
        ? fetchConnector(target.name, target.url, MESSAGES.agentReady, MESSAGES.agentFailed)
        : Promise.resolve({
            label: target.name,
            status: "mock" as const,
            detail: MESSAGES.agentPending
          })
    )
  );

  return { title: MESSAGES.agentTitle, items };
}

function parseRssUrls(env: AppEnv): string[] {
  return (env.NEWS_RSS_URLS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

async function collectNews(env: AppEnv): Promise<ReportSection> {
  const urls = parseRssUrls(env);
  const items: ConnectorItem[] = [];

  if (env.NEWS_SEARCH_ENDPOINT) {
    items.push(await fetchConnector("web_search", env.NEWS_SEARCH_ENDPOINT, MESSAGES.newsReady, MESSAGES.newsFailed));
  }

  for (const [index, url] of urls.entries()) {
    items.push(await fetchConnector(`rss_${index + 1}`, url, MESSAGES.newsReady, MESSAGES.newsFailed));
  }

  if (items.length === 0) {
    items.push({
      label: "news",
      status: "mock",
      detail: MESSAGES.newsPending
    });
  }

  return { title: MESSAGES.newsTitle, items };
}

function summarizeStatus(sections: ReportSection[]): string {
  const failed = sections.flatMap((section) => section.items).filter((item) => item.status === "failed").length;
  if (failed > 0) {
    return `${MESSAGES.summary}: ${failed} failed`;
  }
  return MESSAGES.summary;
}

async function buildReport(env: AppEnv): Promise<DailyReport> {
  const now = new Date();
  const sections = await Promise.all([collectCalendar(env), runAgents(env), collectNews(env)]);
  return {
    id: crypto.randomUUID(),
    date: getKoreanDate(env.ASSISTANT_TIMEZONE, now),
    generatedAt: now.toISOString(),
    timezone: env.ASSISTANT_TIMEZONE,
    summary: summarizeStatus(sections),
    sections,
    delivery: {
      kakao: env.KAKAO_WEBHOOK_URL ? "pending" : "skipped",
      dashboard: "ready",
      googleDrive: env.GOOGLE_DRIVE_REPORT_ENDPOINT ? "pending" : "skipped"
    }
  };
}

function toKakaoMessage(report: DailyReport): string {
  const lines = [
    `[${report.date}] ${MESSAGES.kakaoTitle}`,
    report.summary,
    "",
    ...report.sections.flatMap((section) => [
      `* ${section.title}`,
      ...section.items.map((item) => `- ${item.label}: ${item.detail}`),
      ""
    ])
  ];
  return lines.join("\n").trim();
}

async function sendKakaoIfConfigured(env: AppEnv, report: DailyReport): Promise<DailyReport> {
  if (!env.KAKAO_WEBHOOK_URL) {
    return report;
  }

  try {
    const response = await fetch(env.KAKAO_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ text: toKakaoMessage(report), report })
    });

    return {
      ...report,
      delivery: {
        ...report.delivery,
        kakao: response.ok ? "sent" : "failed"
      }
    };
  } catch (error) {
    console.error(JSON.stringify({ event: "kakao_send_failed", error: String(error) }));
    return {
      ...report,
      delivery: {
        ...report.delivery,
        kakao: "failed"
      }
    };
  }
}

async function persistToGoogleDriveIfConfigured(env: AppEnv, report: DailyReport): Promise<DeliveryState> {
  if (!env.GOOGLE_DRIVE_REPORT_ENDPOINT) {
    return "skipped";
  }

  try {
    const response = await fetch(env.GOOGLE_DRIVE_REPORT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(report)
    });
    return response.ok ? "sent" : "failed";
  } catch (error) {
    console.error(JSON.stringify({ event: "google_drive_persist_failed", error: String(error) }));
    return "failed";
  }
}

async function generateAndDeliver(env: AppEnv, ctx: ExecutionContext): Promise<DailyReport> {
  const report = await buildReport(env);
  const delivered = await sendKakaoIfConfigured(env, report);

  ctx.waitUntil(
    persistToGoogleDriveIfConfigured(env, delivered).then((state) => {
      if (state === "failed") {
        console.error(JSON.stringify({ event: "google_drive_delivery_failed", reportId: delivered.id }));
      }
    })
  );

  return delivered;
}

async function routeApi(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/health") {
    return json({ ok: true, service: "bichangi-agent", mode: env.REPORT_MODE });
  }

  if (url.pathname === "/api/report/latest" && request.method === "GET") {
    return json(await buildReport(env));
  }

  if (url.pathname === "/api/report/run" && request.method === "POST") {
    const report = await generateAndDeliver(env, ctx);
    return json(report);
  }

  return json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return routeApi(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(generateAndDeliver(env, ctx));
  }
};
