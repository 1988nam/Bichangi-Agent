import type { AgentEvent, AppEnv, DailyReport, Memory } from "./types";

// KV-backed persistence. Coarse JSON documents written ~once/day and read whole
// — the textbook KV access pattern (see research notes).

const K_LATEST = "report:latest";
const K_MEMORY = "memory";
const DAY_TTL_SECONDS = 60 * 60 * 24 * 60; // keep daily snapshots ~60 days

function dayKey(date: string): string {
  return `report:${date}`;
}

export function parseRssEnv(env: AppEnv): string[] {
  return (env.NEWS_RSS_URLS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export function defaultMemory(env: AppEnv, now: string): Memory {
  return {
    newsKeywords: [],
    excludedTopics: [],
    publishers: [],
    rssUrls: parseRssEnv(env),
    agents: {},
    unfinishedTasks: [],
    kakaoPreferredTime: null,
    updatedAt: now,
  };
}

// Normalize any partial/legacy stored memory into a complete object.
function normalizeMemory(env: AppEnv, raw: Partial<Memory> | null, now: string): Memory {
  const base = defaultMemory(env, now);
  if (!raw) return base;
  return {
    newsKeywords: Array.isArray(raw.newsKeywords) ? raw.newsKeywords : base.newsKeywords,
    excludedTopics: Array.isArray(raw.excludedTopics) ? raw.excludedTopics : base.excludedTopics,
    publishers: Array.isArray(raw.publishers) ? raw.publishers : base.publishers,
    // Honor an explicitly-stored empty array so the user can clear RSS sources
    // even when NEWS_RSS_URLS provides defaults (only seed defaults when absent).
    rssUrls: Array.isArray(raw.rssUrls) ? raw.rssUrls : base.rssUrls,
    agents: raw.agents && typeof raw.agents === "object" ? raw.agents : {},
    unfinishedTasks: Array.isArray(raw.unfinishedTasks) ? raw.unfinishedTasks : [],
    kakaoPreferredTime: raw.kakaoPreferredTime ?? null,
    updatedAt: raw.updatedAt ?? now,
  };
}

export async function getMemory(env: AppEnv, now: string): Promise<Memory> {
  const raw = await env.REPORTS.get<Partial<Memory>>(K_MEMORY, "json");
  return normalizeMemory(env, raw, now);
}

export async function saveMemory(env: AppEnv, memory: Memory): Promise<void> {
  await env.REPORTS.put(K_MEMORY, JSON.stringify(memory));
}

export async function getLatestReport(env: AppEnv): Promise<DailyReport | null> {
  return await env.REPORTS.get<DailyReport>(K_LATEST, "json");
}

export async function saveReport(env: AppEnv, report: DailyReport): Promise<void> {
  await Promise.all([
    env.REPORTS.put(K_LATEST, JSON.stringify(report)),
    env.REPORTS.put(dayKey(report.date), JSON.stringify(report), {
      expirationTtl: DAY_TTL_SECONDS,
    }),
  ]);
}

export async function getReportByDate(env: AppEnv, date: string): Promise<DailyReport | null> {
  return await env.REPORTS.get<DailyReport>(dayKey(date), "json");
}

export interface HistoryEntry {
  date: string;
  key: string;
}

export async function listRecentReports(env: AppEnv, limit = 30): Promise<HistoryEntry[]> {
  const { keys } = await env.REPORTS.list({ prefix: "report:", limit: 1000 });
  return keys
    .filter((k) => k.name !== K_LATEST)
    .map((k) => ({ date: k.name.slice("report:".length), key: k.name }))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, limit);
}

// ---- Agent events (pushed via POST /api/agent-event) -------------------
const EVENT_TTL_SECONDS = 60 * 60 * 24 * 7; // keep 7 days
const K_EVENTS_CURSOR = "events:cursor";

// One KV key per event (key sorts by ISO time) to avoid read-modify-write races
// and the 1-write/sec-per-key limit during bursts.
export async function addEvent(env: AppEnv, ev: AgentEvent): Promise<void> {
  const suffix = crypto.randomUUID().slice(0, 8);
  await env.REPORTS.put(`event:${ev.at}:${suffix}`, JSON.stringify(ev), {
    expirationTtl: EVENT_TTL_SECONDS,
  });
}

export async function getRecentEvents(env: AppEnv, sinceIso?: string, limit = 30): Promise<AgentEvent[]> {
  const { keys } = await env.REPORTS.list({ prefix: "event:", limit: 1000 });
  let names = keys.map((k) => k.name);
  if (sinceIso) names = names.filter((n) => n.slice("event:".length) >= sinceIso);
  names.sort((a, b) => (a < b ? 1 : -1)); // newest first
  names = names.slice(0, limit);
  const events = await Promise.all(names.map((n) => env.REPORTS.get<AgentEvent>(n, "json")));
  return events.filter((e): e is AgentEvent => e !== null);
}

export async function getEventsCursor(env: AppEnv): Promise<string | null> {
  return await env.REPORTS.get(K_EVENTS_CURSOR);
}

export async function setEventsCursor(env: AppEnv, iso: string): Promise<void> {
  await env.REPORTS.put(K_EVENTS_CURSOR, iso);
}

// Round-trip probe used by diagnostics to confirm KV read+write actually work.
export async function probeStorage(env: AppEnv): Promise<{ ok: boolean; detail: string }> {
  const probeKey = "diag:probe";
  const stamp = `${Date.now()}`;
  try {
    await env.REPORTS.put(probeKey, stamp, { expirationTtl: 60 });
    const back = await env.REPORTS.get(probeKey);
    if (back === stamp) return { ok: true, detail: "KV 읽기/쓰기 정상" };
    return { ok: false, detail: `KV 값 불일치 (기대 ${stamp}, 실제 ${back ?? "null"})` };
  } catch (err) {
    return { ok: false, detail: `KV 접근 실패: ${String(err)}` };
  }
}
