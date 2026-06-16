import type { AppEnv, Memory, NewsItem, NewsResult } from "./types";
import { fetchText, trimDetail } from "./util";
import { parseFeed, getFeedTitle } from "./feed";

const RECENCY_MS = 48 * 60 * 60 * 1000;
const MAX_ITEMS = 15;

function hostOf(url: string): string {
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

async function collectFromRss(url: string, memory: Memory): Promise<NewsItem[]> {
  const res = await fetchText(url, {}, 12_000);
  if (!res.ok || !res.text) return [];
  const feedTitle = getFeedTitle(res.text) || hostOf(url);
  const now = Date.now();

  const items: NewsItem[] = [];
  for (const item of parseFeed(res.text)) {
    if (!item.title) continue;
    const haystack = `${item.title} ${item.summary}`;
    if (isExcluded(haystack, memory.excludedTopics)) continue;
    if (item.publishedAt && now - item.publishedAt.getTime() > RECENCY_MS) continue;
    items.push({
      title: item.title,
      url: item.link,
      source: feedTitle,
      publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
      summary: trimDetail(item.summary, 300),
      matchedKeywords: matchedKeywords(haystack, memory.newsKeywords),
    });
  }
  return items;
}

async function collectFromSearch(env: AppEnv, memory: Memory): Promise<NewsItem[]> {
  if (!env.NEWS_SEARCH_ENDPOINT) return [];
  const url = new URL(env.NEWS_SEARCH_ENDPOINT);
  if (memory.newsKeywords.length && !url.searchParams.has("q")) {
    url.searchParams.set("q", memory.newsKeywords.join(" "));
  }
  const res = await fetchText(url.toString(), {}, 12_000);
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

export async function collectNews(env: AppEnv, memory: Memory): Promise<NewsResult> {
  const sources: Promise<NewsItem[]>[] = memory.rssUrls.map((u) => collectFromRss(u, memory));
  sources.push(collectFromSearch(env, memory));

  const settled = await Promise.allSettled(sources);
  const collected = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  if (memory.rssUrls.length === 0 && !env.NEWS_SEARCH_ENDPOINT) {
    return {
      status: "mock",
      detail: "뉴스 소스 미설정 — 대시보드에서 RSS URL/키워드를 추가하거나 NEWS_RSS_URLS를 설정하세요.",
      items: [],
    };
  }

  const ranked = dedupe(collected).sort((a, b) => {
    const ka = a.matchedKeywords?.length ?? 0;
    const kb = b.matchedKeywords?.length ?? 0;
    if (ka !== kb) return kb - ka;
    const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return tb - ta;
  });

  const items = ranked.slice(0, MAX_ITEMS);
  if (items.length === 0) {
    return {
      status: "failed",
      detail: "설정된 소스에서 최근 기사를 가져오지 못했습니다 (네트워크/형식/필터 확인).",
      items: [],
    };
  }
  return {
    status: "ok",
    detail: `${items.length}건 수집 (소스 ${memory.rssUrls.length + (env.NEWS_SEARCH_ENDPOINT ? 1 : 0)}개)`,
    items,
  };
}
