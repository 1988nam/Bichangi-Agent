const labels = {
  subtitle: "\uc77c\uc815, Agent \uc5c5\ub370\uc774\ud2b8, \uc624\ub298 \ub274\uc2a4\ub97c \uc9e7\uac8c \uc815\ub9ac\ud569\ub2c8\ub2e4.",
  run: "\uc218\ub3d9 \uc2e4\ud589",
  status: "\uc0c1\ud0dc",
  date: "\ub0a0\uc9dc",
  kakao: "\uce74\uce74\uc624\ud1a1",
  loading: "\ubd88\ub7ec\uc624\ub294 \uc911",
  checking: "\ucd5c\uc2e0 \ub9ac\ud3ec\ud2b8 \ud655\uc778 \uc911",
  running: "\uc218\ub3d9 \uc2e4\ud589 \uc911"
};

const statusEl = document.querySelector("#status");
const dateEl = document.querySelector("#date");
const kakaoEl = document.querySelector("#kakao");
const sectionsEl = document.querySelector("#sections");
const runButton = document.querySelector("#runButton");

document.querySelector("#subtitle").textContent = labels.subtitle;
document.querySelector("#statusLabel").textContent = labels.status;
document.querySelector("#dateLabel").textContent = labels.date;
document.querySelector("#kakaoLabel").textContent = labels.kakao;
runButton.textContent = labels.run;
statusEl.textContent = labels.loading;

function setStatus(text) {
  statusEl.textContent = text;
}

function renderReport(report) {
  dateEl.textContent = report.date;
  kakaoEl.textContent = report.delivery.kakao;
  setStatus(report.summary);
  sectionsEl.replaceChildren(
    ...report.sections.map((section) => {
      const article = document.createElement("article");
      article.className = "section";

      const title = document.createElement("h2");
      title.textContent = section.title;

      const list = document.createElement("ul");
      for (const item of section.items) {
        const li = document.createElement("li");
        li.textContent = `${item.label}: ${item.detail}`;
        li.dataset.status = item.status;
        list.append(li);
      }

      article.append(title, list);
      return article;
    })
  );
}

async function loadLatest() {
  setStatus(labels.checking);
  const response = await fetch("/api/report/latest");
  renderReport(await response.json());
}

async function runNow() {
  runButton.disabled = true;
  setStatus(labels.running);
  try {
    const response = await fetch("/api/report/run", { method: "POST" });
    renderReport(await response.json());
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", runNow);
loadLatest();
