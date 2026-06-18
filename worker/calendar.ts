import type { AppEnv, CalendarEvent, CalendarResult, CalendarTask } from "./types";
import { fetchText, formatKoreanTime, getKoreanDate } from "./util";

interface RawCalendar {
  events?: unknown;
  tasks?: unknown;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeEvents(raw: unknown): CalendarEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e): CalendarEvent | null => {
      if (!e || typeof e !== "object") return null;
      const o = e as Record<string, unknown>;
      const summary = asString(o.summary ?? o.title ?? o.name).trim();
      const start = asString(o.start ?? o.startTime ?? o.begin ?? o.date).trim();
      if (!summary && !start) return null;
      return {
        summary: summary || "(제목 없음)",
        start,
        end: o.end != null ? asString(o.end) : undefined,
        allDay: Boolean(o.allDay ?? o.all_day),
      };
    })
    .filter((e): e is CalendarEvent => e !== null);
}

function normalizeTasks(raw: unknown): CalendarTask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t): CalendarTask | null => {
      if (!t || typeof t !== "object") return null;
      const o = t as Record<string, unknown>;
      const title = asString(o.title ?? o.summary ?? o.name).trim();
      if (!title) return null;
      return {
        title,
        due: o.due != null ? asString(o.due) : undefined,
        done: Boolean(o.done ?? o.completed),
      };
    })
    .filter((t): t is CalendarTask => t !== null);
}

// A uniform "HH:mm" sort key so mixed ISO timestamps and bare "HH:mm" strings
// order chronologically (unparseable/all-day → end).
function startSortKey(start: string, tz: string): string {
  if (!start) return "99:99";
  const d = new Date(start);
  if (!Number.isNaN(d.getTime())) return formatKoreanTime(start, tz);
  const m = start.match(/(\d{1,2}):(\d{2})/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  return "99:98";
}

// Keep events that overlap `today` (KST): single-day events today AND multi-day
// events that started earlier but are still ongoing (e.g. shared multi-day events).
function isToday(event: CalendarEvent, today: string, tz: string): boolean {
  if (!event.start) return true;
  const s = new Date(event.start);
  if (Number.isNaN(s.getTime())) return true; // can't tell — keep it
  const startDay = getKoreanDate(tz, s);
  let endDay = startDay;
  if (event.end) {
    const e = new Date(event.end);
    if (!Number.isNaN(e.getTime())) endDay = getKoreanDate(tz, e);
  }
  return startDay <= today && today <= endDay;
}

// Human-friendly KST time label for display/summarization.
function eventWhen(event: CalendarEvent, today: string, tz: string): string {
  if (!event.start) return "시간미정";
  const s = new Date(event.start);
  if (Number.isNaN(s.getTime())) return event.start;
  const startDay = getKoreanDate(tz, s);
  let endDay = startDay;
  if (event.end) {
    const e = new Date(event.end);
    if (!Number.isNaN(e.getTime())) endDay = getKoreanDate(tz, e);
  }
  if (startDay < today) return `진행 중(~${endDay.slice(5)})`; // started earlier, still ongoing
  if (event.allDay) return "종일";
  if (startDay !== endDay) return `${formatKoreanTime(event.start, tz)}~`; // multi-day starting today
  return formatKoreanTime(event.start, tz);
}

export async function collectCalendar(env: AppEnv): Promise<CalendarResult> {
  if (!env.GOOGLE_CALENDAR_ENDPOINT) {
    return {
      status: "mock",
      detail: "Google Calendar 엔드포인트 미설정 — GOOGLE_CALENDAR_ENDPOINT 시크릿을 설정하세요.",
      events: [],
      tasks: [],
    };
  }

  const res = await fetchText(env.GOOGLE_CALENDAR_ENDPOINT, {}, 12_000);
  if (!res.ok) {
    return {
      status: "failed",
      detail: `Calendar 수집 실패: HTTP ${res.status}${res.error ? ` (${res.error})` : ""}`,
      events: [],
      tasks: [],
    };
  }

  let parsed: RawCalendar;
  try {
    parsed = JSON.parse(res.text) as RawCalendar;
  } catch {
    return {
      status: "failed",
      detail: "Calendar 응답이 JSON이 아닙니다. 엔드포인트가 events/tasks JSON을 반환해야 합니다.",
      events: [],
      tasks: [],
    };
  }

  const tz = env.ASSISTANT_TIMEZONE || "Asia/Seoul";
  const today = getKoreanDate(tz);
  const allEvents = normalizeEvents(parsed.events);
  const events = allEvents
    .filter((e) => isToday(e, today, tz))
    .sort((a, b) => startSortKey(a.start, tz).localeCompare(startSortKey(b.start, tz)))
    .map((e) => ({ ...e, when: eventWhen(e, today, tz) }));
  const tasks = normalizeTasks(parsed.tasks);

  return {
    status: "ok",
    detail: `오늘 일정 ${events.length}건, 할 일 ${tasks.filter((t) => !t.done).length}건`,
    events,
    tasks,
  };
}
