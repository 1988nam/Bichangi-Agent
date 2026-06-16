const $ = (id) => document.getElementById(id);

// Sends the saved AUTH_TOKEN (if any) as a Bearer header. On a 401 it prompts
// once, stores the token, and retries. When the API is open (no AUTH_TOKEN set
// server-side) this is a transparent passthrough.
async function authFetch(url, opts = {}) {
  const token = localStorage.getItem("bichangi_token");
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401) {
    const entered = prompt("API 토큰(AUTH_TOKEN)을 입력하세요:");
    if (entered) {
      localStorage.setItem("bichangi_token", entered);
      return authFetch(url, opts);
    }
  }
  return res;
}

const statusColors = {
  ok: "ok",
  unchanged: "ok",
  sent: "ok",
  ready: "ok",
  changed: "warn",
  pending: "warn",
  mock: "muted",
  skipped: "muted",
  failed: "bad",
};

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text ?? "-";
}

function fmtTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ko-KR", { hour12: false });
}

function renderReport(report) {
  const b = report.briefing ?? {};
  setText("status", report.raw ? "최신 브리핑" : "데이터 없음");
  setText("date", report.date);
  setText("generatedAt", fmtTime(report.generatedAt));
  const engine = b.generatedBy === "gemini" ? `Gemini (${b.model ?? "?"})` : "규칙 기반(폴백)";
  setText("engine", engine);
  const engineEl = $("engine");
  if (engineEl) engineEl.dataset.status = b.generatedBy === "gemini" ? "ok" : "warn";

  setText("kakao", report.delivery?.kakao ?? "-");
  const kakaoEl = $("kakao");
  if (kakaoEl) kakaoEl.dataset.status = statusColors[report.delivery?.kakao] ?? "muted";

  setText("headline", b.headline ?? "오늘의 브리핑");
  setText("kakaoText", b.kakaoText ?? "-");
  setText("schedule", b.schedule ?? "-");
  setText("agents", b.agents ?? "-");
  setText("news", b.news ?? "-");
  if (b.note) {
    setText("status", `${report.raw ? "최신 브리핑" : ""} · ${b.note}`);
  }

  const actions = $("actionItems");
  actions.replaceChildren(
    ...(b.actionItems?.length ? b.actionItems : ["(없음)"]).map((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      return li;
    }),
  );

  renderRaw(report.raw ?? {});
}

function pill(el, status) {
  if (!el) return;
  el.textContent = status ?? "";
  el.dataset.status = statusColors[status] ?? "muted";
}

function renderRaw(raw) {
  pill($("calStatus"), raw.calendar?.status);
  pill($("newsStatus"), raw.news?.status);

  const cal = $("rawCalendar");
  const calItems = [];
  for (const e of raw.calendar?.events ?? []) {
    calItems.push(`${e.start || "시간미정"} — ${e.summary}`);
  }
  for (const t of raw.calendar?.tasks ?? []) {
    calItems.push(`${t.done ? "✓" : "□"} ${t.title}`);
  }
  if (!calItems.length) calItems.push(raw.calendar?.detail ?? "데이터 없음");
  cal.replaceChildren(...calItems.map((t) => liText(t)));

  const ag = $("rawAgents");
  ag.replaceChildren(
    ...(raw.agents ?? []).map((a) => {
      const li = liText(`${a.name} · ${a.kind} — ${a.detail}`);
      li.dataset.status = statusColors[a.status] ?? "muted";
      return li;
    }),
  );

  const news = $("rawNews");
  const items = raw.news?.items ?? [];
  if (!items.length) {
    news.replaceChildren(liText(raw.news?.detail ?? "데이터 없음"));
  } else {
    news.replaceChildren(
      ...items.map((n) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = n.url || "#";
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = n.title;
        const src = document.createElement("span");
        src.className = "src";
        src.textContent = ` ${n.source}${n.matchedKeywords?.length ? " · " + n.matchedKeywords.join(",") : ""}`;
        li.append(a, src);
        return li;
      }),
    );
  }
}

function liText(text) {
  const li = document.createElement("li");
  li.textContent = text;
  return li;
}

async function loadLatest() {
  setText("status", "최신 리포트 확인 중…");
  try {
    const res = await authFetch("/api/report/latest");
    renderReport(await res.json());
  } catch (err) {
    setText("status", `불러오기 실패: ${err}`);
  }
}

async function runNow() {
  const btn = $("runButton");
  btn.disabled = true;
  setText("status", "실행 중… (수집 + 요약 + 전달)");
  try {
    const res = await authFetch("/api/report/run", { method: "POST" });
    renderReport(await res.json());
  } catch (err) {
    setText("status", `실행 실패: ${err}`);
  } finally {
    btn.disabled = false;
  }
}

async function loadDiagnostics(live) {
  const card = $("diagCard");
  card.hidden = false;
  setText("diagSummary", live ? "실호출 검증 중…" : "진단 중…");
  $("diagChecks").replaceChildren();
  try {
    const res = await authFetch(`/api/diagnostics${live ? "?live=1" : ""}`);
    const d = await res.json();
    setText(
      "diagSummary",
      `정상 ${d.summary.ok} · 실패 ${d.summary.failed} · 미설정 ${d.summary.unconfigured} · 기준 ${fmtTime(d.generatedAt)}`,
    );
    $("diagChecks").replaceChildren(
      ...d.checks.map((c) => {
        const li = document.createElement("li");
        const status = !c.configured ? "muted" : c.ok ? "ok" : "bad";
        li.dataset.status = status;
        const mark = !c.configured ? "—" : c.ok ? "✓" : "✕";
        li.innerHTML = `<strong>${mark} ${escapeHtml(c.label)}</strong> ${escapeHtml(c.detail)}`;
        return li;
      }),
    );
  } catch (err) {
    setText("diagSummary", `진단 실패: ${err}`);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function splitList(value) {
  return value
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

async function loadMemory() {
  try {
    const res = await authFetch("/api/memory");
    const m = await res.json();
    $("memKeywords").value = (m.newsKeywords ?? []).join(", ");
    $("memExcluded").value = (m.excludedTopics ?? []).join(", ");
    $("memRss").value = (m.rssUrls ?? []).join("\n");
    $("memKakaoTime").value = m.kakaoPreferredTime ?? "";
  } catch {
    /* ignore */
  }
}

async function saveMemory() {
  const body = {
    newsKeywords: splitList($("memKeywords").value),
    excludedTopics: splitList($("memExcluded").value),
    rssUrls: splitList($("memRss").value),
    kakaoPreferredTime: $("memKakaoTime").value.trim() || null,
  };
  setText("memSaved", "저장 중…");
  try {
    const res = await authFetch("/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await res.json();
    setText("memSaved", "저장됨 ✓");
  } catch (err) {
    setText("memSaved", `저장 실패: ${err}`);
  }
}

$("runButton").addEventListener("click", runNow);
$("diagButton").addEventListener("click", () => loadDiagnostics(false));
$("diagLiveButton").addEventListener("click", () => loadDiagnostics(true));
$("saveMemory").addEventListener("click", saveMemory);

loadLatest();
loadMemory();
