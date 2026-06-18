/// <reference path="../worker-configuration.d.ts" />

// All bindings, vars, and secrets the Worker uses. Kept standalone (not
// extending Cloudflare.Env) so manual edits never conflict with the literal
// types emitted by `wrangler types`.
export interface AppEnv {
  // Bindings
  REPORTS: KVNamespace;
  ASSETS: Fetcher;

  // Plain vars (wrangler.jsonc "vars")
  ASSISTANT_TIMEZONE: string;
  REPORT_MODE?: string;
  PUBLIC_BASE_URL?: string;
  GEMINI_MODEL?: string;
  // Override the Gemini base (up to ".../models"). Set to a Cloudflare AI Gateway
  // google-ai-studio URL to proxy through a supported region (works around
  // "User location is not supported" from the Workers edge).
  GEMINI_BASE_URL?: string;

  // Secrets (wrangler secret put / .dev.vars)
  AUTH_TOKEN?: string; // when set, gates mutating/side-effecting /api routes
  AGENT_INGEST_TOKEN?: string; // token agents use to POST /api/agent-event (falls back to AUTH_TOKEN)
  AI_GATEWAY_TOKEN?: string; // cf-aig-authorization Bearer for an authenticated AI Gateway
  GEMINI_API_KEY?: string;
  KAKAO_WEBHOOK_URL?: string;
  KAKAO_REST_API_KEY?: string;
  KAKAO_CLIENT_SECRET?: string;
  KAKAO_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_REPORT_ENDPOINT?: string;
  GOOGLE_CALENDAR_ENDPOINT?: string;

  // Agent homepages (always present as vars) + optional real status APIs
  AGENT_TUCHANGI_URL?: string;
  AGENT_GACHANGI_URL?: string;
  AGENT_DACHANGI_URL?: string;
  AGENT_BUCHANGI_URL?: string;
  AGENT_TUCHANGI_STATUS_URL?: string;
  AGENT_GACHANGI_STATUS_URL?: string;
  AGENT_DACHANGI_STATUS_URL?: string;
  AGENT_BUCHANGI_STATUS_URL?: string;

  NEWS_RSS_URLS?: string;
  NEWS_SEARCH_ENDPOINT?: string;
}

export type DeliveryState = "pending" | "sent" | "skipped" | "failed";

// ---- Calendar ----------------------------------------------------------
export interface CalendarEvent {
  summary: string;
  start: string; // ISO or HH:mm
  end?: string;
  allDay?: boolean;
  when?: string; // human-friendly KST label (HH:mm / 종일 / 진행 중(~MM-DD))
}

export interface CalendarTask {
  title: string;
  due?: string;
  done?: boolean;
}

export interface CalendarResult {
  status: "ok" | "mock" | "failed";
  detail: string;
  events: CalendarEvent[];
  tasks: CalendarTask[];
}

// ---- Agents ------------------------------------------------------------
export type AgentKind = "status-api" | "homepage" | "none";

export interface AgentStatus {
  name: string;
  url?: string;
  kind: AgentKind;
  status: "ok" | "changed" | "unchanged" | "failed" | "mock";
  changed: boolean;
  detail: string;
  contentHash?: string;
}

// ---- Agent events (pushed by agents) -----------------------------------
export interface AgentEvent {
  agent: string;
  level: "info" | "alert";
  title: string;
  detail?: string;
  items?: string[];
  at: string; // ISO
}

// ---- News --------------------------------------------------------------
export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  summary: string;
  matchedKeywords?: string[];
}

export interface NewsResult {
  status: "ok" | "mock" | "failed";
  detail: string;
  items: NewsItem[];
}

// ---- Memory (persisted in KV) -----------------------------------------
export interface AgentMemory {
  lastStatus: string;
  lastHash?: string;
  lastSeenAt?: string;
  history: { at: string; status: string; note: string }[];
}

export interface Memory {
  newsKeywords: string[];
  excludedTopics: string[];
  publishers: string[];
  rssUrls: string[];
  agents: Record<string, AgentMemory>;
  unfinishedTasks: string[];
  kakaoPreferredTime: string | null;
  updatedAt: string;
}

// ---- Briefing (the "brain" output) ------------------------------------
export interface Briefing {
  kakaoText: string; // <= 180 chars, importance-sorted notification
  headline: string;
  schedule: string;
  agents: string;
  news: string;
  actionItems: string[];
  memoryUpdates: string[];
  generatedBy: "gemini" | "fallback";
  model?: string;
  note?: string;
}

export interface DailyReport {
  id: string;
  date: string;
  generatedAt: string;
  timezone: string;
  mode: string;
  briefing: Briefing;
  raw: {
    calendar: CalendarResult;
    agents: AgentStatus[];
    news: NewsResult;
    events: AgentEvent[];
  };
  delivery: {
    kakao: DeliveryState;
    dashboard: "ready";
    googleDrive: DeliveryState;
  };
}
