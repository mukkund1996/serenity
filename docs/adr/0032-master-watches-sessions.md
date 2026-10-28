# 0032 · The master reads status on demand and watches sessions; hook status is checked against Claude's own

**Status:** Accepted · 2026-10-28

## Context
The master chat saw session status only in the snapshot prepended to each user message, so it went stale within a turn and it had no way to act "as soon as" a session finished, e.g. post a Slack message. Status itself also lagged or stuck, because hooks (0006) miss some changes:
- **Esc interrupts a turn without a `Stop` hook**, so the card stayed working.
- **A permission prompt answered in the pane** fires no hook until the tool finishes (`PostToolUse`), so a long command showed waiting for minutes.
- A hook call that fails (daemon restarting, timeout) is lost for good.

The adopted-session observer (0016) also swept only every 30 s when its file watcher missed a change.

## Decision
- **`session_status`** (MCP): one session's status right now, with its last prompt and reply, or every session's snapshot.
- **`watch_session`** (MCP): returns at once; when the session's turn ends (it stops working, or ends), the daemon sends the chat a message that starts with `serenity:`. Finished or ended, the watch is over; waiting on the user, it stays. One watch per session, `cancel` removes it. The chat never blocks or polls.
- serenity's messages are **never stored as the user's**, so they cannot confirm a Slack send. One that arrives mid-turn waits for the turn to end.
- **A Slack message confirmed ahead of time** goes in `slack_text`, checked with the same proof as 0030 (the user's latest message answered a master reply showing that text). It is released only when the session finishes (idle or done), and sends without another prompt once; before that, or with other text, the send stops at `y`/`n` as before.
- **Hook status is reconciled with Claude's session file** (`<config>/sessions/<pid>.json`, matched by Claude session id or pane). When Claude's `status` changed after the last hook arrived and has held for 1 s, it wins: busy → working (from idle, done or waiting); idle → idle (from working without subagents, or waiting). The observer sweeps every 5 s, and on every change to that folder.

## Consequences
- Watches and released Slack messages live in memory; a daemon restart drops them, and the master has to watch again.
- The reconciliation depends on an undocumented Claude Code file, like 0016; without `statusUpdatedAt` it does nothing and hooks alone decide.
- "Finished" for a watch is the end of a turn (idle), not the Haiku worker's done, which comes seconds later.
