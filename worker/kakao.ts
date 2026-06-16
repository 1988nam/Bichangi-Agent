import type { AppEnv } from "./types";
import { html, json, escapeHtml } from "./util";

const DEFAULT_BASE = "https://bichangi-agent.1988nam.workers.dev";
const KAKAO_TEXT_LIMIT = 200;

interface KakaoTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface KakaoSendResult {
  ok: boolean;
  mode: "direct" | "webhook" | "skipped";
  error?: string;
}

function originOf(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

// The public base URL whose domain MUST be registered in Kakao's Product Link
// (Web 도메인). A request origin wins when available (login/callback); the cron
// path relies on PUBLIC_BASE_URL.
export function publicBaseUrl(env: AppEnv, request?: Request): string {
  if (request) return originOf(request);
  return (env.PUBLIC_BASE_URL && env.PUBLIC_BASE_URL.trim()) || DEFAULT_BASE;
}

function redirectUri(request: Request): string {
  return `${originOf(request)}/api/kakao/callback`;
}

export function routeKakaoLogin(request: Request, env: AppEnv): Response {
  if (!env.KAKAO_REST_API_KEY) {
    return json(
      { error: "missing_kakao_rest_api_key", next: "npx wrangler secret put KAKAO_REST_API_KEY" },
      { status: 500 },
    );
  }
  const authorizeUrl = new URL("https://kauth.kakao.com/oauth/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", env.KAKAO_REST_API_KEY);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri(request));
  authorizeUrl.searchParams.set("scope", "talk_message");
  return Response.redirect(authorizeUrl.toString(), 302);
}

export async function routeKakaoCallback(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return html(`<h1>Kakao login failed</h1><p>${escapeHtml(error)}</p><p>${escapeHtml(errorDescription ?? "")}</p>`, {
      status: 400,
    });
  }
  if (!code) {
    return html("<h1>Kakao callback ready</h1><p>No authorization code was provided.</p>", { status: 400 });
  }
  if (!env.KAKAO_REST_API_KEY) {
    return html(
      [
        "<h1>Kakao authorization code received</h1>",
        "<p>Set KAKAO_REST_API_KEY, then retry /api/kakao/login.</p>",
        "<pre>npx wrangler secret put KAKAO_REST_API_KEY</pre>",
      ].join(""),
    );
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: env.KAKAO_REST_API_KEY,
    redirect_uri: redirectUri(request),
    code,
  });
  if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);

  let tokenResponse: Response;
  let tokenPayload: KakaoTokenResponse;
  try {
    tokenResponse = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
      body,
      signal: AbortSignal.timeout(12_000),
    });
    tokenPayload = (await tokenResponse.json()) as KakaoTokenResponse;
  } catch (err) {
    return html(
      `<h1>Kakao 토큰 교환 실패</h1><p>네트워크/응답 오류로 토큰을 받지 못했습니다. /api/kakao/login 으로 다시 시도하세요.</p><pre>${escapeHtml(String(err))}</pre>`,
      { status: 502 },
    );
  }

  if (!tokenResponse.ok || !tokenPayload.refresh_token) {
    return json({ error: "kakao_token_exchange_failed", detail: tokenPayload }, { status: 400 });
  }

  return html(
    [
      "<h1>Kakao refresh token issued</h1>",
      "<p>이 refresh token을 한 번만 복사해 Cloudflare 시크릿으로 저장하세요.</p>",
      `<textarea rows="8" cols="90" readonly>${escapeHtml(tokenPayload.refresh_token)}</textarea>`,
      "<pre>npx wrangler secret put KAKAO_REFRESH_TOKEN</pre>",
      "<p>저장 후 1회 재배포하고 /api/kakao/send-test로 전달을 검증하세요.</p>",
    ].join(""),
  );
}

export async function getKakaoAccessToken(env: AppEnv): Promise<KakaoTokenResponse> {
  if (!env.KAKAO_REST_API_KEY || !env.KAKAO_REFRESH_TOKEN) {
    return { error: "missing_kakao_credentials" };
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env.KAKAO_REST_API_KEY,
    refresh_token: env.KAKAO_REFRESH_TOKEN,
  });
  if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);

  try {
    const response = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
      body,
      signal: AbortSignal.timeout(12_000),
    });
    return (await response.json()) as KakaoTokenResponse;
  } catch (err) {
    return { error: "token_request_failed", error_description: String(err) };
  }
}

// Kakao's text template hard-caps the body at 200 chars (over-length sends are
// rejected). Trim defensively so the brain's notification always delivers.
export function clampKakaoText(text: string): string {
  const t = text.trim();
  if (t.length <= KAKAO_TEXT_LIMIT) return t;
  return `${t.slice(0, KAKAO_TEXT_LIMIT - 1)}…`;
}

export async function sendKakaoDirect(env: AppEnv, text: string, baseUrl: string): Promise<KakaoSendResult> {
  const tokenPayload = await getKakaoAccessToken(env);
  if (!tokenPayload.access_token) {
    return { ok: false, mode: "direct", error: tokenPayload.error ?? "access_token_failed" };
  }

  const templateObject = {
    object_type: "text",
    text: clampKakaoText(text),
    link: { web_url: baseUrl, mobile_web_url: baseUrl },
    button_title: "비서 열기",
  };
  const body = new URLSearchParams({ template_object: JSON.stringify(templateObject) });

  let response: Response;
  try {
    response = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        "content-type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body,
      signal: AbortSignal.timeout(12_000),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "kakao_send_threw", error: String(err) }));
    return { ok: false, mode: "direct", error: String(err) };
  }

  if (response.ok) return { ok: true, mode: "direct" };
  const detail = await response.text().catch(() => "");
  console.error(JSON.stringify({ event: "kakao_send_failed", status: response.status, detail }));
  return { ok: false, mode: "direct", error: `HTTP ${response.status}: ${detail.slice(0, 200)}` };
}

// Primary delivery (direct API) with relay-webhook fallback.
export async function sendKakao(env: AppEnv, text: string, baseUrl: string): Promise<KakaoSendResult> {
  if (env.KAKAO_REST_API_KEY && env.KAKAO_REFRESH_TOKEN) {
    return sendKakaoDirect(env, text, baseUrl);
  }
  if (env.KAKAO_WEBHOOK_URL) {
    try {
      const response = await fetch(env.KAKAO_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ text }),
      });
      return response.ok
        ? { ok: true, mode: "webhook" }
        : { ok: false, mode: "webhook", error: `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, mode: "webhook", error: String(err) };
    }
  }
  return { ok: false, mode: "skipped", error: "no_kakao_credentials" };
}

// Cheap liveness check for diagnostics: can we mint an access token?
export async function checkKakao(env: AppEnv): Promise<{ ok: boolean; detail: string }> {
  if (!env.KAKAO_REST_API_KEY) return { ok: false, detail: "KAKAO_REST_API_KEY 미설정" };
  if (!env.KAKAO_REFRESH_TOKEN) {
    return { ok: false, detail: "KAKAO_REFRESH_TOKEN 미설정 — /api/kakao/login으로 발급" };
  }
  const token = await getKakaoAccessToken(env);
  if (token.access_token) return { ok: true, detail: "토큰 갱신 성공 (전송 준비됨)" };
  return {
    ok: false,
    detail: `토큰 갱신 실패: ${token.error ?? "unknown"}${token.error_description ? ` (${token.error_description})` : ""}`,
  };
}
