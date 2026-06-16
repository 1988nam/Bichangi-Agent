from __future__ import annotations

import html
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from codex_secretary.runner import get_paths


def _load_latest(root: Path) -> dict:
    latest_path = get_paths(root).latest_json
    if not latest_path.exists():
        return {
            "date": "not generated",
            "generated_at": "",
            "report": "아직 생성된 리포트가 없습니다. 먼저 `codex-secretary run-daily`를 실행하세요.",
        }
    return json.loads(latest_path.read_text(encoding="utf-8"))


def _render_dashboard(latest: dict) -> str:
    report = html.escape(latest.get("report", ""))
    date = html.escape(latest.get("date", ""))
    generated_at = html.escape(latest.get("generated_at", ""))
    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Secretary</title>
  <style>
    :root {{
      color-scheme: light;
      font-family: "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
      background: #f6f7f9;
      color: #1e252d;
    }}
    body {{
      margin: 0;
    }}
    header {{
      background: #ffffff;
      border-bottom: 1px solid #d9dee7;
      padding: 18px 24px;
    }}
    main {{
      max-width: 980px;
      margin: 0 auto;
      padding: 24px;
    }}
    h1 {{
      font-size: 22px;
      margin: 0 0 6px;
    }}
    .meta {{
      color: #5d6875;
      font-size: 14px;
    }}
    .panel {{
      background: #ffffff;
      border: 1px solid #d9dee7;
      border-radius: 8px;
      padding: 20px;
    }}
    pre {{
      white-space: pre-wrap;
      word-break: keep-all;
      line-height: 1.65;
      margin: 0;
      font-family: inherit;
      font-size: 15px;
    }}
  </style>
</head>
<body>
  <header>
    <h1>Codex Secretary</h1>
    <div class="meta">리포트 날짜: {date} · 생성: {generated_at}</div>
  </header>
  <main>
    <section class="panel">
      <pre>{report}</pre>
    </section>
  </main>
</body>
</html>"""


def make_handler(root: Path):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            latest = _load_latest(root)
            if self.path == "/api/latest":
                body = json.dumps(latest, ensure_ascii=False, indent=2).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            body = _render_dashboard(latest).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return

    return Handler


def serve(root: Path | None = None, host: str = "127.0.0.1", port: int = 8765) -> None:
    project_root = root or Path.cwd()
    server = ThreadingHTTPServer((host, port), make_handler(project_root))
    print(f"Codex Secretary dashboard: http://{host}:{port}")
    server.serve_forever()
