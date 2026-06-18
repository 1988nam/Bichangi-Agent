// Small shared helpers used across the Worker modules.

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function getKoreanDate(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// "HH:mm" for an ISO timestamp in the given timezone.
export function formatKoreanTime(iso: string, timezone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

const TEXT_LIMIT_BYTES = 24_000;

export async function readLimitedText(response: Response, limit = TEXT_LIMIT_BYTES): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < limit) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const remaining = limit - received;
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

export function trimDetail(text: string, max = 280): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

export interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}

// SSRF guard: block requests to loopback/private/link-local hosts and bare
// internal hostnames. Server-side fetch targets (RSS, calendar, agents) can be
// user-supplied, so every fetchText() call is validated here.
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  if (h.includes(":")) {
    // IPv6 literal: loopback (::1), unique-local (fc../fd..), link-local (fe8/9/a/b)
    if (h === "::1") return true;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    return false;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (!h.includes(".")) return true; // bare hostname → likely internal
  return false;
}

export function validateOutboundUrl(url: string): { ok: true; url: URL } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: `blocked_scheme: ${parsed.protocol}` };
  }
  if (isBlockedHost(parsed.hostname)) {
    return { ok: false, error: `blocked_host: ${parsed.hostname}` };
  }
  return { ok: true, url: parsed };
}

export async function fetchText(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000,
  limit = TEXT_LIMIT_BYTES,
): Promise<FetchTextResult> {
  const check = validateOutboundUrl(url);
  if (!check.ok) {
    return { ok: false, status: 0, text: "", error: check.error };
  }
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json, text/plain, application/xml, application/rss+xml, text/xml;q=0.9, */*;q=0.5",
        "user-agent": "BichangiAgent/1.0 (+https://github.com/1988nam/Bichangi-Agent)",
        ...(init.headers ?? {}),
      },
    });
    const text = await readLimitedText(response, limit);
    return { ok: response.ok, status: response.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: String(err) };
  }
}

// Fetch via a service binding (for same-account Workers that URL fetch can't
// reach). The binding ignores the URL host and routes to the bound Worker; the
// path + query still matter, so pass the full status URL.
export async function fetchViaBinding(
  binding: Fetcher,
  url: string,
  timeoutMs = 12_000,
): Promise<FetchTextResult> {
  try {
    const res = await binding.fetch(url, {
      headers: { accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await readLimitedText(res);
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: String(err) };
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function nowIso(): string {
  return new Date().toISOString();
}
