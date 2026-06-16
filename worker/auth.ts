import type { AppEnv } from "./types";
import { json } from "./util";

// Lightweight shared-secret gate. When AUTH_TOKEN is set, mutating and
// side-effecting /api routes require the token (Bearer header, ?token=, or a
// cookie). When unset the API stays open (local dev / first run) and diagnostics
// flags it. For stronger isolation, front the Worker with Cloudflare Access.

export function authConfigured(env: AppEnv): boolean {
  return Boolean(env.AUTH_TOKEN && env.AUTH_TOKEN.length > 0);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function presentedToken(request: Request, url: URL): string | null {
  const header = request.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const q = url.searchParams.get("token");
  if (q) return q;
  const cookie = request.headers.get("cookie");
  if (cookie) {
    const m = cookie.match(/(?:^|;\s*)bichangi_token=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

export function isAuthorized(request: Request, env: AppEnv, url: URL): boolean {
  if (!authConfigured(env)) return true;
  const token = presentedToken(request, url);
  return token != null && timingSafeEqual(token, env.AUTH_TOKEN as string);
}

export function unauthorized(): Response {
  return json(
    { error: "unauthorized", hint: "AUTH_TOKEN 필요 — Authorization: Bearer <token> 또는 ?token=" },
    { status: 401 },
  );
}
