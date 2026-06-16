from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from codex_secretary.graph import build_daily_run_graph


KST = ZoneInfo("Asia/Seoul")


@dataclass(frozen=True)
class RunPaths:
    root: Path
    config: Path
    data: Path
    reports: Path
    latest_json: Path


def get_paths(root: Path | None = None) -> RunPaths:
    project_root = root or Path.cwd()
    data_dir = project_root / "data"
    return RunPaths(
        root=project_root,
        config=project_root / "config" / "assistant.json",
        data=data_dir,
        reports=data_dir / "reports",
        latest_json=data_dir / "latest_report.json",
    )


def load_config(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def write_daily_report(result: dict, paths: RunPaths, now: datetime | None = None) -> Path:
    run_time = now or datetime.now(KST)
    report_date = run_time.strftime("%Y-%m-%d")
    report_path = paths.reports / f"{report_date}.md"

    paths.reports.mkdir(parents=True, exist_ok=True)
    report_path.write_text(result["report"], encoding="utf-8")

    latest = {
        "date": report_date,
        "generated_at": run_time.isoformat(),
        "report_path": str(report_path),
        "calendar_summary": result.get("calendar_summary", ""),
        "agent_summary": result.get("agent_summary", ""),
        "news_summary": result.get("news_summary", ""),
        "memory_updates": result.get("memory_updates", []),
        "delivery_result": result.get("delivery_result", ""),
        "report": result.get("report", ""),
    }
    paths.data.mkdir(parents=True, exist_ok=True)
    paths.latest_json.write_text(
        json.dumps(latest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return report_path


def run_daily(root: Path | None = None) -> dict:
    paths = get_paths(root)
    config = load_config(paths.config)
    graph = build_daily_run_graph()
    result = graph.invoke({"config": config})
    report_path = write_daily_report(result, paths)
    return {**result, "report_path": str(report_path)}
