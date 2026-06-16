# Assistant Build Brief

## Mission

Build a personal operations assistant that runs daily, summarizes what matters, and reports primarily through KakaoTalk.

## Primary Workflows

1. Schedule and task summary
   - Read Google Calendar.
   - Organize today's schedule, recurring routines, unfinished tasks, and next actions.
   - Create or modify calendar events automatically when needed.
   - Ask for confirmation before deleting calendar events.

2. Agent update summary
   - Run 투챙이, 가챙이, 다챙이, 부챙이 in the background.
   - Collect each agent's output.
   - Compare with previous execution history.
   - Summarize changes, failures, and next actions.

3. Today's news summary
   - Collect news from web search, RSS feeds, selected publishers, and configured keywords.
   - Exclude unwanted topics.
   - Summarize briefly, sorted by importance, with action items when relevant.

4. Daily report delivery
   - Generate a daily summary file.
   - Show the same report in a local web dashboard.
   - Send the short version through KakaoTalk.

## Tone

Korean, short, practical, and operations-focused.

## Memory

The assistant should remember:

- Daily recurring schedules and routines.
- Frequently watched news keywords and excluded topics.
- Previous execution results and change history for 투챙이, 가챙이, 다챙이, 부챙이.
- Unfinished tasks and next actions.
- Preferred KakaoTalk notification time.
- Summary style: brief, sorted by importance, focused on action items.

## Interfaces

Primary:

- KakaoTalk notification-centered workflow.

Secondary:

- Local web app dashboard for schedule, news, and agent execution results.

## Safety Rules

Automatic:

- Google Calendar event creation and modification.
- KakaoTalk message sending.
- Agent background execution.
- Cloudflare deployment and configuration changes.
- News source and keyword list changes.
- Daily automation schedule changes.

Require confirmation:

- Google Calendar event deletion.
- File deletion or overwrite.

## First Implementation Slice

Build the local core before connecting external accounts:

1. Define assistant configuration files for agents, news sources, memory, and safety rules.
2. Add a LangGraph runtime with workflow nodes:
   - load_config
   - collect_calendar
   - run_agents
   - collect_news
   - update_memory
   - build_daily_report
   - deliver_report
3. Use mock connectors first.
4. Add real connectors one by one:
   - Google Calendar
   - Cloudflare/agent runner
   - RSS and web search
   - KakaoTalk
5. Add local web dashboard after the daily report data format is stable.

## Deployment Target

Final source repository:

- `https://github.com/1988nam/Bichangi-Agent`

Runtime:

- Cloudflare Workers serverless app.
- Backend API and frontend dashboard are deployed together.
- Scheduled execution uses Cloudflare Cron Triggers.
- If server-like persistence or relay behavior is needed, Google Drive will be used as the external storage/relay target through a configured endpoint.
