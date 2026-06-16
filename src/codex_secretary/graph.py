from __future__ import annotations

from typing import Any, Callable, Literal, TypedDict

try:
    from langgraph.graph import END, START, StateGraph
except ModuleNotFoundError:
    START = "__start__"
    END = "__end__"

    class _CompiledGraph:
        def __init__(self, nodes: dict[str, Callable], edges: dict[str, str]):
            self.nodes = nodes
            self.edges = edges

        def invoke(self, state: dict[str, Any]) -> dict[str, Any]:
            current = self.edges[START]
            while current != END:
                state = self.nodes[current](state)
                current = self.edges[current]
            return state

    class StateGraph:
        def __init__(self, _state_type: Any):
            self.nodes: dict[str, Callable] = {}
            self.edges: dict[str, str] = {}

        def add_node(self, name: str, func: Callable) -> None:
            self.nodes[name] = func

        def add_edge(self, source: str, target: str) -> None:
            self.edges[source] = target

        def compile(self) -> _CompiledGraph:
            return _CompiledGraph(self.nodes, self.edges)


QuestionNode = Literal[
    "ask_purpose",
    "ask_audience",
    "ask_tools",
    "ask_memory",
    "ask_interface",
    "ask_safety",
]


class AssistantSpecState(TypedDict, total=False):
    answers: dict[str, str]
    current_question: str
    brief: str


QUESTIONS: dict[QuestionNode, str] = {
    "ask_purpose": "\uc774 \ube44\uc11c\uac00 \uac00\uc7a5 \uba3c\uc800 \uc798\ud574\uc57c \ud558\ub294 \uc77c\uc740 \ubb34\uc5c7\uc778\uac00\uc694?",
    "ask_audience": "\ub204\uac00 \uc4f0\ub294 \ube44\uc11c\uc774\uace0, \ub9d0\ud22c\ub294 \uc5b4\ub5bb\uac8c \ud558\uba74 \uc88b\uc744\uae4c\uc694?",
    "ask_tools": "\uc5b4\ub5a4 \ub3c4\uad6c\ub97c \uc0ac\uc6a9\ud560 \uc218 \uc788\uc5b4\uc57c \ud558\ub098\uc694? \uc608: \ud30c\uc77c, \uce98\ub9b0\ub354, \uc774\uba54\uc77c, \uc6f9\uac80\uc0c9, \ube0c\ub77c\uc6b0\uc800, GitHub",
    "ask_memory": "\uc2dc\uac04\uc774 \uc9c0\ub098\ub3c4 \ubb34\uc5c7\uc744 \uae30\uc5b5\ud574\uc57c \ud558\ub098\uc694? \ub610\ub294 \uae30\uc5b5\ud558\uc9c0 \ub9d0\uc544\uc57c \ud558\ub098\uc694?",
    "ask_interface": "\uc5b4\ub514\uc5d0\uc11c \uc4f0\uace0 \uc2f6\ub098\uc694? \uc608: CLI, \ub85c\uceec \uc6f9\uc571, Codex \uc2a4\ub808\ub4dc, ChatGPT \uc571, \ubaa8\ubc14\uc77c \uc6f9",
    "ask_safety": "\uc5b4\ub5a4 \ud589\ub3d9\uc740 \uc2e4\ud589 \uc804\uc5d0 \ubc18\ub4dc\uc2dc \ud655\uc778\ubc1b\uc544\uc57c \ud558\ub098\uc694?",
}


def make_question_node(node_name: QuestionNode):
    def node(state: AssistantSpecState) -> AssistantSpecState:
        return {"current_question": QUESTIONS[node_name], **state}

    return node


def build_brief(state: AssistantSpecState) -> AssistantSpecState:
    answers = state.get("answers", {})
    lines = [
        "# Assistant Build Brief",
        "",
        f"- Mission: {answers.get('ask_purpose', 'TBD')}",
        f"- User and tone: {answers.get('ask_audience', 'TBD')}",
        f"- Tools: {answers.get('ask_tools', 'TBD')}",
        f"- Memory policy: {answers.get('ask_memory', 'TBD')}",
        f"- Interface: {answers.get('ask_interface', 'TBD')}",
        f"- Confirmation rules: {answers.get('ask_safety', 'TBD')}",
    ]
    return {**state, "brief": "\n".join(lines)}


def build_question_graph():
    graph = StateGraph(AssistantSpecState)

    for node_name in QUESTIONS:
        graph.add_node(node_name, make_question_node(node_name))

    graph.add_node("build_brief", build_brief)

    ordered_nodes = list(QUESTIONS)
    graph.add_edge(START, ordered_nodes[0])
    for current_node, next_node in zip(ordered_nodes, ordered_nodes[1:]):
        graph.add_edge(current_node, next_node)
    graph.add_edge(ordered_nodes[-1], "build_brief")
    graph.add_edge("build_brief", END)

    return graph.compile()


class DailyRunState(TypedDict, total=False):
    config: dict[str, Any]
    calendar_summary: str
    agent_summary: str
    news_summary: str
    memory_updates: list[str]
    report: str
    delivery_result: str


def load_config(state: DailyRunState) -> DailyRunState:
    return {**state, "config": state.get("config", {})}


def collect_calendar(state: DailyRunState) -> DailyRunState:
    return {
        **state,
        "calendar_summary": "Google Calendar connector pending. Mock: \uc624\ub298 \uc77c\uc815\uacfc \ubbf8\uc644\ub8cc \ud560 \uc77c\uc744 \uc694\uc57d\ud569\ub2c8\ub2e4.",
    }


def run_agents(state: DailyRunState) -> DailyRunState:
    agent_names = [
        agent.get("name", "unknown")
        for agent in state.get("config", {}).get("agents", [])
        if agent.get("enabled", True)
    ]
    names = ", ".join(agent_names) if agent_names else "\ud22c\ucc59\uc774, \uac00\ucc59\uc774, \ub2e4\ucc59\uc774, \ubd80\ucc59\uc774"
    return {
        **state,
        "agent_summary": f"Agent runner pending. Mock: {names} \uc2e4\ud589 \uacb0\uacfc\uc640 \ubcc0\uacbd \ub0b4\uc5ed\uc744 \uc694\uc57d\ud569\ub2c8\ub2e4.",
    }


def collect_news(state: DailyRunState) -> DailyRunState:
    return {
        **state,
        "news_summary": "News connectors pending. Mock: \uc6f9 \uac80\uc0c9, RSS, \ud0a4\uc6cc\ub4dc \uae30\ubc18 \uc624\ub298 \ub274\uc2a4\ub97c \uc694\uc57d\ud569\ub2c8\ub2e4.",
    }


def update_memory(state: DailyRunState) -> DailyRunState:
    updates = [
        "\ubc18\ubcf5 \uc77c\uc815/\ub8e8\ud2f4",
        "\ub274\uc2a4 \ud0a4\uc6cc\ub4dc/\uc81c\uc678 \uc8fc\uc81c",
        "Agent \uc2e4\ud589 \uc774\ub825",
        "\ubbf8\uc644\ub8cc \ud560 \uc77c/\ub2e4\uc74c \uc561\uc158",
    ]
    return {**state, "memory_updates": updates}


def build_daily_report(state: DailyRunState) -> DailyRunState:
    report = "\n".join(
        [
            "# Daily Assistant Report",
            "",
            "## \uc77c\uc815/\ud560 \uc77c",
            state.get("calendar_summary", ""),
            "",
            "## Agent \uc5c5\ub370\uc774\ud2b8",
            state.get("agent_summary", ""),
            "",
            "## \uc624\ub298 \ub274\uc2a4",
            state.get("news_summary", ""),
            "",
            "## \uba54\ubaa8\ub9ac \uc5c5\ub370\uc774\ud2b8",
            "\n".join(f"- {item}" for item in state.get("memory_updates", [])),
        ]
    )
    return {**state, "report": report}


def deliver_report(state: DailyRunState) -> DailyRunState:
    return {
        **state,
        "delivery_result": "Delivery pending. Mock: \uc694\uc57d \ud30c\uc77c, \ud654\uba74 \ucd9c\ub825, \uce74\uce74\uc624\ud1a1 \uc54c\ub9bc\uc73c\ub85c \uc804\ub2ec\ud569\ub2c8\ub2e4.",
    }


def build_daily_run_graph():
    graph = StateGraph(DailyRunState)

    graph.add_node("load_config", load_config)
    graph.add_node("collect_calendar", collect_calendar)
    graph.add_node("run_agents", run_agents)
    graph.add_node("collect_news", collect_news)
    graph.add_node("update_memory", update_memory)
    graph.add_node("build_daily_report", build_daily_report)
    graph.add_node("deliver_report", deliver_report)

    graph.add_edge(START, "load_config")
    graph.add_edge("load_config", "collect_calendar")
    graph.add_edge("collect_calendar", "run_agents")
    graph.add_edge("run_agents", "collect_news")
    graph.add_edge("collect_news", "update_memory")
    graph.add_edge("update_memory", "build_daily_report")
    graph.add_edge("build_daily_report", "deliver_report")
    graph.add_edge("deliver_report", END)

    return graph.compile()
