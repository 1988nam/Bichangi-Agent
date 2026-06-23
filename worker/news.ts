import type { AppEnv, Memory, NewsItem, NewsResult } from "./types";
import { fetchText, trimDetail } from "./util";
import { parseFeed, getFeedTitle } from "./feed";

const RECENCY_MS = 48 * 60 * 60 * 1000;
const MAX_ITEMS = 15;

// Real feeds are far bigger than util's default 24KB cap (Google News ~95KB),
// and truncation silently drops most items — fetch the whole feed instead.
export const FEED_LIMIT_BYTES = 1_000_000;

// Many publishers serve a consent/redirect HTML page (or 429) to bot user-agents.
// A normal browser UA avoids the UA-based block; looksLikeFeed() catches the
// IP-based one (200 OK but not RSS) so collectNews can report it instead of
// returning a silent empty list.
export const FEED_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
};

export function looksLikeFeed(text: string): boolean {
  return /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]|<channel[\s>]|<(item|entry)[\s>]/i.test(text);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "news";
  }
}

function matchedKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((k) => k && lower.includes(k.toLowerCase()));
}

function isExcluded(text: string, excluded: string[]): boolean {
  const lower = text.toLowerCase();
  return excluded.some((t) => t && lower.includes(t.toLowerCase()));
}

// Per-source outcome so collectNews can explain *why* 0 items came back
// (network/block vs format vs filter) instead of a single opaque message.
interface SourceResult {
  url: string;
  items: NewsItem[];
  ok: boolean; // fetched AND the body parsed as a feed
  status: number; // HTTP status (0 = network error / timeout / blocked host)
  error?: string; // "not_feed" | "empty" | network error string
  parsed: number; // total <item>/<entry> blocks parsed
  kept: number; // items remaining after exclude/recency filters
}

async function collectFromRss(url: string, memory: Memory): Promise<SourceResult> {
  const out: SourceResult = { url, items: [], ok: false, status: 0, parsed: 0, kept: 0 };

  const res = await fetchText(url, { headers: FEED_HEADERS }, 12_000, FEED_LIMIT_BYTES);
  out.status = res.status;
  if (!res.ok) {
    out.error = res.error ?? `http_${res.status}`;
    return out;
  }
  if (!res.text) {
    out.error = "empty";
    return out;
  }
  if (!looksLikeFeed(res.text)) {
    out.error = "not_feed"; // 200 OK but not RSS — consent/redirect page or block
    return out;
  }

  const parsedItems = parseFeed(res.text);
  out.parsed = parsedItems.length;
  const feedTitle = getFeedTitle(res.text) || hostOf(url);
  const now = Date.now();

  for (const item of parsedItems) {
    if (!item.title) continue;
    const haystack = `${item.title} ${item.summary}`;
    if (isExcluded(haystack, memory.excludedTopics)) continue;
    if (item.publishedAt && now - item.publishedAt.getTime() > RECENCY_MS) continue;
    out.items.push({
      title: item.title,
      url: item.link,
      source: feedTitle,
      publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
      summary: trimDetail(item.summary, 300),
      matchedKeywords: matchedKeywords(haystack, memory.newsKeywords),
    });
  }
  out.kept = out.items.length;
  out.ok = true;
  return out;
}

async function collectFromSearch(env: AppEnv, memory: Memory): Promise<NewsItem[]> {
  if (!env.NEWS_SEARCH_ENDPOINT) return [];
  const url = new URL(env.NEWS_SEARCH_ENDPOINT);
  if (memory.newsKeywords.length && !url.searchParams.has("q")) {
    url.searchParams.set("q", memory.newsKeywords.join(" "));
  }
  const res = await fetchText(url.toString(), { headers: FEED_HEADERS }, 12_000, FEED_LIMIT_BYTES);
  if (!res.ok || !res.text) return [];
  try {
    const data = JSON.parse(res.text) as { items?: unknown; results?: unknown };
    const arr = (Array.isArray(data.items) ? data.items : data.results) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((raw): NewsItem | null => {
        if (!raw || typeof raw !== "object") return null;
        const o = raw as Record<string, unknown>;
        const title = String(o.title ?? o.headline ?? "").trim();
        if (!title) return null;
        const link = String(o.url ?? o.link ?? "");
        const haystack = `${title} ${String(o.summary ?? o.description ?? "")}`;
        if (isExcluded(haystack, memory.excludedTopics)) return null;
        return {
          title,
          url: link,
          source: String(o.source ?? o.publisher ?? (link ? hostOf(link) : "web_search")),
          publishedAt: o.publishedAt ? String(o.publishedAt) : null,
          summary: trimDetail(String(o.summary ?? o.description ?? ""), 300),
          matchedKeywords: matchedKeywords(haystack, memory.newsKeywords),
        };
      })
      .filter((i): i is NewsItem => i !== null);
  } catch {
    return [];
  }
}

function dedupe(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of items) {
    const key = (item.url || item.title).toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// Turn the per-source outcomes into one human-readable reason for "0 items".
function describeFailure(
  rss: SourceResult[],
  env: AppEnv,
  searchItems: NewsItem[],
  searchError: string | undefined,
): string {
  const parts: string[] = [];
  for (const r of rss) {
    const host = hostOf(r.url);
    if (!r.ok) {
      if (r.status === 0) parts.push(`${host}: 도달 실패(${r.error ?? "network"})`);
      else if (r.error === "not_feed") parts.push(`${host}: HTTP ${r.status}인데 RSS 아님(차단/동의 페이지 추정)`);
      else parts.push(`${host}: HTTP ${r.status}`);
    } else if (r.parsed === 0) {
      parts.push(`${host}: 항목 0건(형식 불일치)`);
    } else if (r.kept === 0) {
      parts.push(`${host}: ${r.parsed}건 중 최근48h·제외주제 필터로 0건`);
    }
  }
  if (env.NEWS_SEARCH_ENDPOINT) {
    if (searchError) parts.push(`검색: 오류(${searchError})`);
    else if (searchItems.length === 0) parts.push("검색: 0건");
  }
  const reason = parts.length ? parts.join(" · ") : "원인 불명 (네트워크/형식/필터 확인)";
  return trimDetail(`최근 기사 0건 — ${reason}`, 300);
}

// Single-source probe used by diagnostics so /api/diagnostics reports feed-ness
// and item count (not just HTTP status) from the real runtime IP.
export async function probeRss(url: string): Promise<{ ok: boolean; status: number; error?: string; items: number }> {
  const res = await fetchText(url, { headers: FEED_HEADERS }, 10_000, FEED_LIMIT_BYTES);
  if (!res.ok) return { ok: false, status: res.status, error: res.error ?? `http_${res.status}`, items: 0 };
  if (!res.text) return { ok: false, status: res.status, error: "empty", items: 0 };
  if (!looksLikeFeed(res.text)) return { ok: false, status: res.status, error: "not_feed", items: 0 };
  return { ok: true, status: res.status, items: parseFeed(res.text).length };
}

export async function collectNews(env: AppEnv, memory: Memory): Promise<NewsResult> {
  if (memory.rssUrls.length === 0 && !env.NEWS_SEARCH_ENDPOINT) {
    return {
      status: "mock",
      detail: "뉴스 소스 미설정 — 대시보드에서 RSS URL/키워드를 추가하거나 NEWS_RSS_URLS를 설정하세요.",
      items: [],
    };
  }

  const rssSettled = await Promise.allSettled(memory.rssUrls.map((u) => collectFromRss(u, memory)));
  const rssResults: SourceResult[] = rssSettled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { url: memory.rssUrls[i], items: [], ok: false, status: 0, error: "exception", parsed: 0, kept: 0 },
  );

  let searchItems: NewsItem[] = [];
  let searchError: string | undefined;
  if (env.NEWS_SEARCH_ENDPOINT) {
    try {
      searchItems = await collectFromSearch(env, memory);
    } catch (err) {
      searchError = String(err);
    }
  }

  const collected = [...rssResults.flatMap((r) => r.items), ...searchItems];
  const ranked = dedupe(collected).sort((a, b) => {
    const ka = a.matchedKeywords?.length ?? 0;
    const kb = b.matchedKeywords?.length ?? 0;
    if (ka !== kb) return kb - ka;
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return tb - ta;
  });

  const items = ranked.slice(0, MAX_ITEMS);
  const sourceCount = memory.rssUrls.length + (env.NEWS_SEARCH_ENDPOINT ? 1 : 0);

  if (items.length === 0) {
    const detail = describeFailure(rssResults, env, searchItems, searchError);
    // Surface raw per-source diagnostics in `wrangler tail` for fast debugging.
    console.warn(
      "[news] 0 items —",
      JSON.stringify(
        rssResults.map((r) => ({ host: hostOf(r.url), status: r.status, error: r.error, parsed: r.parsed, kept: r.kept })),
      ),
      env.NEWS_SEARCH_ENDPOINT ? `search=${searchError ?? searchItems.length}` : "",
    );
    return { status: "failed", detail, items: [] };
  }

  return {
    status: "ok",
    detail: `${items.length}건 수집 (소스 ${sourceCount}개)`,
    items,
  };
}
