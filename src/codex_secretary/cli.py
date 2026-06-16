from __future__ import annotations

import argparse
from pathlib import Path

from codex_secretary.graph import QUESTIONS, build_question_graph
from codex_secretary.runner import run_daily
from codex_secretary.web_app import serve


def ask_questions() -> None:
    answers: dict[str, str] = {}

    print("Codex Secretary question graph\n")
    for key, question in QUESTIONS.items():
        answers[key] = input(f"{question}\n> ").strip()

    graph = build_question_graph()
    result = graph.invoke({"answers": answers})
    print()
    print(result["brief"])


def main() -> None:
    parser = argparse.ArgumentParser(prog="codex-secretary")
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("ask", help="Run the setup question graph.")
    subparsers.add_parser("run-daily", help="Run the daily assistant graph once.")

    web_parser = subparsers.add_parser("web", help="Start the local dashboard.")
    web_parser.add_argument("--host", default="127.0.0.1")
    web_parser.add_argument("--port", type=int, default=8765)

    args = parser.parse_args()
    command = args.command or "ask"

    if command == "ask":
        ask_questions()
        return

    if command == "run-daily":
        result = run_daily(Path.cwd())
        print(result["report"])
        print()
        print(f"Report: {result['report_path']}")
        return

    if command == "web":
        serve(Path.cwd(), host=args.host, port=args.port)
        return


if __name__ == "__main__":
    main()
