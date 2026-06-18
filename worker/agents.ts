import type { AgentKind, AgentStatus, AppEnv, Memory } from "./types";
import { fetchText, fetchViaBinding, sha256Hex, trimDetail } from "./util";
import { stripHtml } from "./feed";

interface AgentTarget {
  name: string;
  homepage?: string;
  statusUrl?: string;
  binding?: Fetcher; // service binding to reach a same-account Worker
}

function targets(env: AppEnv): AgentTarget[] {
  return [
    { name: "투챙이", homepage: env.AGENT_TUCHANGI_URL, statusUrl: env.AGENT_TUCHANGI_STATUS_URL },
    { name: "가챙이", homepage: env.AGENT_GACHANGI_URL, statusUrl: env.AGENT_GACHANGI_STATUS_URL, binding: env.SVC_GACHANGI },
    { name: "다챙이", homepage: env.AGENT_DACHANGI_URL, statusUrl: env.AGENT_DACHANGI_STATUS_URL },
    { name: "부챙이", homepage: env.AGENT_BUCHANGI_URL, statusUrl: env.AGENT_BUCHANGI_STATUS_URL, binding: env.SVC_BUCHANGI },
  ];
}

function extractTitle(htmlText: string): string {
  const m = htmlText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : "";
}

async function probeTarget(target: AgentTarget, prevHash?: string): Promise<AgentStatus> {
  const { name } = target;

  // 1) Real status API (JSON) if configured — the meaningful signal.
  if (target.statusUrl) {
    const res = target.binding
      ? await fetchViaBinding(target.binding, target.statusUrl)
      : await fetchText(target.statusUrl, {}, 12_000);
    if (!res.ok) {
      return {
        name,
        url: target.statusUrl,
        kind: "status-api",
        status: "failed",
        changed: false,
        detail: `상태 API 실패: HTTP ${res.status}${res.error ? ` (${res.error})` : ""}`,
      };
    }
    let summary = trimDetail(res.text, 240);
    let canonical = res.text; // hashed for change detection
    let isAlert = false;
    try {
      const data = JSON.parse(res.text) as Record<string, unknown>;
      const s = data.summary ?? data.status ?? data.state ?? data.message;
      if (s != null) summary = trimDetail(String(s), 240);
      const items = Array.isArray(data.items) ? data.items.map((x) => String(x)) : [];
      if (items.length) summary = `${summary} · ${items.slice(0, 5).join(" / ")}`;
      const level = String(data.level ?? data.severity ?? "").toLowerCase();
      isAlert = level === "alert" || level === "error" || level === "warn";
      // Hash only meaningful fields so a changing updatedAt/timestamp doesn't
      // falsely register as "변경".
      canonical = JSON.stringify({ s: s ?? "", items, level });
    } catch {
      // not JSON; keep trimmed text + full-text hash
    }
    const hash = await sha256Hex(canonical);
    const changed = prevHash !== undefined && prevHash !== hash;
    const changeNote = prevHash === undefined ? " (기준선 저장)" : changed ? " · 변경 감지" : " · 변경 없음";
    return {
      name,
      url: target.statusUrl,
      kind: "status-api",
      status: prevHash === undefined ? "ok" : changed ? "changed" : "unchanged",
      changed,
      detail: `${isAlert ? "⚠️ " : ""}${summary}${changeNote}`,
      contentHash: hash,
    };
  }

  // 2) Homepage fallback — we can only detect "did the deployed page change".
  if (target.homepage) {
    const res = await fetchText(target.homepage, {}, 12_000);
    if (!res.ok) {
      return {
        name,
        url: target.homepage,
        kind: "homepage",
        status: "failed",
        changed: false,
        detail: `홈페이지 접근 실패: HTTP ${res.status}${res.error ? ` (${res.error})` : ""}`,
      };
    }
    const hash = await sha256Hex(res.text);
    const changed = prevHash !== undefined && prevHash !== hash;
    const title = extractTitle(res.text) || stripHtml(res.text).slice(0, 80) || "(내용 없음)";
    const base = `홈페이지 응답 OK · "${title}"`;
    const changeNote =
      prevHash === undefined
        ? " (기준선 저장)"
        : changed
          ? " · 변경 감지"
          : " · 변경 없음";
    return {
      name,
      url: target.homepage,
      kind: "homepage",
      status: prevHash === undefined ? "ok" : changed ? "changed" : "unchanged",
      changed,
      detail: base + changeNote,
      contentHash: hash,
    };
  }

  // 3) Nothing configured.
  return {
    name,
    kind: "none",
    status: "mock",
    changed: false,
    detail: "URL 미설정 — AGENT_*_URL 또는 AGENT_*_STATUS_URL을 설정하세요.",
  };
}

export async function runAgents(env: AppEnv, memory: Memory): Promise<AgentStatus[]> {
  return Promise.all(
    targets(env).map((t) => probeTarget(t, memory.agents[t.name]?.lastHash)),
  );
}
