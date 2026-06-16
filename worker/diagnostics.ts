import type { AppEnv } from "./types";
import { fetchText, nowIso } from "./util";
import { geminiConfigured, generate } from "./gemini";
import { checkKakao, publicBaseUrl } from "./kakao";
import { probeStorage, getMemory } from "./storage";
import { authConfigured } from "./auth";

export interface Check {
  id: string;
  label: string;
  configured: boolean;
  ok: boolean;
  detail: string;
}

export interface Diagnostics {
  generatedAt: string;
  baseUrl: string;
  live: boolean;
  summary: { ok: number; failed: number; unconfigured: number };
  checks: Check[];
}

async function checkGemini(env: AppEnv, live: boolean): Promise<Check> {
  const configured = geminiConfigured(env);
  if (!configured) {
    return { id: "gemini", label: "Gemini 요약 엔진", configured: false, ok: false, detail: "GEMINI_API_KEY 미설정" };
  }
  const model = env.GEMINI_MODEL || "gemini-3.5-flash";
  if (!live) {
    return {
      id: "gemini",
      label: "Gemini 요약 엔진",
      configured: true,
      ok: true,
      detail: `키 설정됨 (모델 ${model}). ?live=1 로 실제 호출 검증`,
    };
  }
  const res = await generate(env, {
    prompt: "한 단어로만 답하세요: OK",
    maxOutputTokens: 64,
    temperature: 0,
  });
  return {
    id: "gemini",
    label: "Gemini 요약 엔진",
    configured: true,
    ok: res.ok,
    detail: res.ok
      ? `호출 성공 (모델 ${res.model})`
      : `호출 실패: ${res.error ?? "unknown"}`,
  };
}

async function checkCalendar(env: AppEnv): Promise<Check> {
  if (!env.GOOGLE_CALENDAR_ENDPOINT) {
    return { id: "calendar", label: "Google Calendar", configured: false, ok: false, detail: "GOOGLE_CALENDAR_ENDPOINT 미설정" };
  }
  const res = await fetchText(env.GOOGLE_CALENDAR_ENDPOINT, {}, 10_000);
  if (!res.ok) {
    return { id: "calendar", label: "Google Calendar", configured: true, ok: false, detail: `HTTP ${res.status}${res.error ? ` (${res.error})` : ""}` };
  }
  try {
    const data = JSON.parse(res.text) as { events?: unknown };
    const n = Array.isArray(data.events) ? data.events.length : 0;
    return { id: "calendar", label: "Google Calendar", configured: true, ok: true, detail: `JSON 응답 OK (events ${n}건)` };
  } catch {
    return { id: "calendar", label: "Google Calendar", configured: true, ok: false, detail: "응답이 events JSON 형식이 아님" };
  }
}

async function checkAgents(env: AppEnv): Promise<Check> {
  const targets = [
    { name: "투챙이", url: env.AGENT_TUCHANGI_STATUS_URL ?? env.AGENT_TUCHANGI_URL, api: Boolean(env.AGENT_TUCHANGI_STATUS_URL) },
    { name: "가챙이", url: env.AGENT_GACHANGI_STATUS_URL ?? env.AGENT_GACHANGI_URL, api: Boolean(env.AGENT_GACHANGI_STATUS_URL) },
    { name: "다챙이", url: env.AGENT_DACHANGI_STATUS_URL ?? env.AGENT_DACHANGI_URL, api: Boolean(env.AGENT_DACHANGI_STATUS_URL) },
    { name: "부챙이", url: env.AGENT_BUCHANGI_STATUS_URL ?? env.AGENT_BUCHANGI_URL, api: Boolean(env.AGENT_BUCHANGI_STATUS_URL) },
  ];
  const configured = targets.filter((t) => t.url).length;
  if (configured === 0) {
    return { id: "agents", label: "에이전트(투/가/다/부)", configured: false, ok: false, detail: "AGENT_*_URL 미설정" };
  }
  const results = await Promise.all(
    targets.map(async (t) => {
      if (!t.url) return { name: t.name, ok: false, note: "미설정" };
      const res = await fetchText(t.url, {}, 8_000);
      return { name: t.name, ok: res.ok, note: res.ok ? (t.api ? "상태API OK" : "홈페이지OK") : `HTTP ${res.status}` };
    }),
  );
  const okCount = results.filter((r) => r.ok).length;
  const apiCount = targets.filter((t) => t.api && t.url).length;
  const detail =
    `도달 ${okCount}/${configured}` +
    (apiCount < configured ? ` · 실제 상태API ${apiCount}개 (나머지는 홈페이지 기준 변경감지만 가능)` : " · 모두 상태API") +
    ` · ${results.map((r) => `${r.name}:${r.note}`).join(", ")}`;
  return { id: "agents", label: "에이전트(투/가/다/부)", configured: true, ok: okCount > 0, detail };
}

async function checkNews(env: AppEnv): Promise<Check> {
  // Sources actually used at run time come from memory (seeded from NEWS_RSS_URLS).
  const memory = await getMemory(env, nowIso());
  const rss = memory.rssUrls;
  const hasSearch = Boolean(env.NEWS_SEARCH_ENDPOINT);
  if (rss.length === 0 && !hasSearch) {
    return { id: "news", label: "뉴스 소스", configured: false, ok: false, detail: "RSS/검색 엔드포인트 미설정 — 대시보드 메모리에서 RSS를 추가하세요" };
  }
  if (rss.length === 0) {
    return { id: "news", label: "뉴스 소스", configured: true, ok: true, detail: "검색 엔드포인트만 설정됨" };
  }
  const res = await fetchText(rss[0], {}, 10_000);
  return {
    id: "news",
    label: "뉴스 소스",
    configured: true,
    ok: res.ok,
    detail: res.ok ? `RSS ${rss.length}개 설정 · 첫 소스 도달 OK` : `첫 RSS 실패: HTTP ${res.status}`,
  };
}

async function checkKakaoDelivery(env: AppEnv): Promise<Check> {
  const configured = Boolean(env.KAKAO_REST_API_KEY) || Boolean(env.KAKAO_WEBHOOK_URL);
  const res = await checkKakao(env);
  return { id: "kakao", label: "카카오톡 전달", configured, ok: res.ok, detail: res.detail };
}

async function checkStorage(env: AppEnv): Promise<Check> {
  const res = await probeStorage(env);
  return { id: "storage", label: "KV 저장소", configured: true, ok: res.ok, detail: res.detail };
}

function checkAuth(env: AppEnv): Check {
  const on = authConfigured(env);
  return {
    id: "auth",
    label: "API 인증",
    configured: on,
    ok: on,
    detail: on
      ? "AUTH_TOKEN 설정됨 — 변경/실행 API가 토큰으로 보호됨"
      : "AUTH_TOKEN 미설정 — /api 가 공개 상태. 개인용이면 'wrangler secret put AUTH_TOKEN' 권장",
  };
}

// Never let one rejecting check 500 the whole diagnostics page.
async function safe(id: string, label: string, run: () => Promise<Check>): Promise<Check> {
  try {
    return await run();
  } catch (err) {
    return { id, label, configured: true, ok: false, detail: `점검 중 오류: ${String(err)}` };
  }
}

export async function runDiagnostics(env: AppEnv, request: Request, live: boolean): Promise<Diagnostics> {
  const baseUrl = publicBaseUrl(env, request);
  const checks = await Promise.all([
    safe("gemini", "Gemini 요약 엔진", () => checkGemini(env, live)),
    safe("storage", "KV 저장소", () => checkStorage(env)),
    safe("calendar", "Google Calendar", () => checkCalendar(env)),
    safe("agents", "에이전트(투/가/다/부)", () => checkAgents(env)),
    safe("news", "뉴스 소스", () => checkNews(env)),
    safe("kakao", "카카오톡 전달", () => checkKakaoDelivery(env)),
  ]);
  checks.push(checkAuth(env));

  // Reminder check: Kakao link domain must be registered.
  checks.push({
    id: "kakao_domain",
    label: "카카오 링크 도메인 등록",
    configured: true,
    ok: true,
    detail: `알림 버튼 링크=${baseUrl} — 이 도메인을 카카오 개발자 콘솔 [제품 링크 관리 > Web 도메인]에 등록해야 -401 없이 전송됩니다.`,
  });

  const summary = {
    ok: checks.filter((c) => c.configured && c.ok).length,
    failed: checks.filter((c) => c.configured && !c.ok).length,
    unconfigured: checks.filter((c) => !c.configured).length,
  };

  return { generatedAt: nowIso(), baseUrl, live, summary, checks };
}
