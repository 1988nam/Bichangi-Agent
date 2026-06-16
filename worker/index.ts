import type { AppEnv, Memory } from "./types";
import { json, getKoreanDate, nowIso } from "./util";
import { buildReport } from "./report";
import { runDiagnostics } from "./diagnostics";
import { getLatestReport, getMemory, saveMemory, listRecentReports, getReportByDate } from "./storage";
import {
  routeKakaoLogin,
  routeKakaoCallback,
  sendKakaoDirect,
  publicBaseUrl,
} from "./kakao";
import { isAuthorized, unauthorized } from "./auth";

// Routes reachable without AUTH_TOKEN: health, and the Kakao OAuth browser
// redirects (which can't carry a Bearer header). Everything else is gated when
// AUTH_TOKEN is set.
const PUBLIC_PATHS = new Set(["/api/health", "/api/kakao/login", "/api/kakao/callback"]);

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => String(x).trim()).filter((x) => x.length > 0);
}

async function updateMemoryFromBody(env: AppEnv, body: unknown): Promise<Memory> {
  const memory = await getMemory(env, nowIso());
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const keywords = asStringArray(o.newsKeywords);
    const excluded = asStringArray(o.excludedTopics);
    const publishers = asStringArray(o.publishers);
    const rssUrls = asStringArray(o.rssUrls);
    const unfinished = asStringArray(o.unfinishedTasks);
    if (keywords) memory.newsKeywords = keywords;
    if (excluded) memory.excludedTopics = excluded;
    if (publishers) memory.publishers = publishers;
    if (rssUrls) memory.rssUrls = rssUrls;
    if (unfinished) memory.unfinishedTasks = unfinished;
    if ("kakaoPreferredTime" in o) {
      memory.kakaoPreferredTime = o.kakaoPreferredTime == null ? null : String(o.kakaoPreferredTime);
    }
  }
  memory.updatedAt = nowIso();
  await saveMemory(env, memory);
  return memory;
}

async function routeApi(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (!PUBLIC_PATHS.has(pathname) && !isAuthorized(request, env, url)) {
    return unauthorized();
  }

  if (pathname === "/api/health") {
    return json({ ok: true, service: "bichangi-agent", mode: env.REPORT_MODE ?? "live", time: nowIso() });
  }

  if (pathname === "/api/report/latest" && method === "GET") {
    const stored = await getLatestReport(env);
    if (stored) return json(stored);
    // No report yet — generate one (without delivery) so the dashboard isn't empty.
    return json(await buildReport(env, { deliver: false }));
  }

  if (pathname === "/api/report/run" && method === "POST") {
    return json(await buildReport(env, { deliver: true, request, ctx }));
  }

  if (pathname === "/api/report/history" && method === "GET") {
    return json({ reports: await listRecentReports(env, 30) });
  }

  const dateMatch = pathname.match(/^\/api\/report\/(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch && method === "GET") {
    const report = await getReportByDate(env, dateMatch[1]);
    return report ? json(report) : json({ error: "not_found", date: dateMatch[1] }, { status: 404 });
  }

  if (pathname === "/api/diagnostics" && method === "GET") {
    const live = url.searchParams.get("live") === "1" || url.searchParams.get("live") === "true";
    return json(await runDiagnostics(env, request, live));
  }

  if (pathname === "/api/memory" && method === "GET") {
    return json(await getMemory(env, nowIso()));
  }

  if (pathname === "/api/memory" && method === "POST") {
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, { status: 400 });
    }
    return json(await updateMemoryFromBody(env, body));
  }

  if (pathname === "/api/kakao/login" && method === "GET") {
    return routeKakaoLogin(request, env);
  }
  if (pathname === "/api/kakao/callback" && method === "GET") {
    return routeKakaoCallback(request, env);
  }
  if (pathname === "/api/kakao/send-test" && method === "GET") {
    const baseUrl = publicBaseUrl(env, request);
    const res = await sendKakaoDirect(
      env,
      `[${getKoreanDate(env.ASSISTANT_TIMEZONE || "Asia/Seoul")}] 비서 카카오 연결 테스트`,
      baseUrl,
    );
    return json(res, { status: res.ok ? 200 : 500 });
  }

  return json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env, ctx);
      } catch (err) {
        console.error(JSON.stringify({ event: "api_error", path: url.pathname, error: String(err) }));
        return json({ error: "internal_error", detail: String(err) }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      buildReport(env, { deliver: true, ctx })
        .then((r) => console.log(JSON.stringify({ event: "scheduled_report", id: r.id, kakao: r.delivery.kakao })))
        .catch((err) => console.error(JSON.stringify({ event: "scheduled_failed", error: String(err) }))),
    );
  },
};
