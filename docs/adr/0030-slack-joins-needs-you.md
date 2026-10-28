# 0030 · Slack joins NEEDS YOU: only mentions and DMs that need an action, at most three

**Status:** Accepted · 2026-10-28 · Amends 0023

## Context
ADR 0023 put Slack in its own SLACK section (and a box under the master on the map), one item at a time behind `[` `]`. It took threads the user had replied in where someone wrote after them, which in practice is mostly chatter: thanks, FYIs, a thread moving on without the user. A separate section also split "what needs me" in two, and `[` `]` hid all but one item.

## Decision
- **One list.** Slack items are NEEDS YOU items, after the master's permission requests and the sessions. Each shows `@ <author> in #channel` (or `· dm`) and its age, the action it needs, and the master's ◆ suggestion (0024) with `y e n`. The "N things need you" count includes them. `↑↓` and Tab reach them like any item; `Enter` or `o` opens the message in Slack. `[` `]` step between topics again. The map has no Slack box; the master box shows a selected Slack item as it shows a session.
- **Only mentions and DMs.** Messages that mention the user by name (not @here, @channel or group mentions), and direct and group messages to the user, from the last 7 days. Threads the user merely took part in are out.
- **Only what needs an action.** The inbox worker reads the thread or DM around each message and keeps it only when the user has to do something: answer a question put to them, decide, review or approve, unblock someone, do a task asked of them. It drops FYI, thanks, small talk, questions someone else answered, resolved or withdrawn requests, and anything aimed at someone else; when unsure, it drops. Each item carries `action`, what the user has to do ("Answer whether the auth fix shipped"), shown as the item's line and given to the suggester and the chat. The parser drops any item without an action, or whose reason is not `mention` or `dm`.
- **At most three** (was five). With more, the worker keeps the three most pressing. They sit in NEEDS YOU beside sessions, so every one has to earn its place.
- **A Slack error** (no login, a failed read) takes one yellow row under the status line, in both zooms.

## Consequences
- The triage is the model's judgement. It errs toward dropping, so a real ask can be missed; it still shows in Slack, and the chat can read Slack when asked.
- Reading each thread costs a few more tool calls per read; the poll rate (0023) is unchanged.
