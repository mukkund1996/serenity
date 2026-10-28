# 0034 · The master sends replies the user asked for with `send_reply`

**Status:** Accepted · 2026-10-28

## Context
The chat could only answer a session through `suggest` kind `reply` (0008), which waits in NEEDS YOU for `y`. So "tell dismiss-slack-item to ask questions", then "just send it", still ended at a `y` press: the user approved the same message twice. `set_topic`, `open_session`, `archive_session` and `create_session` already act at once because the user's request is the approval (0033), and a Slack message the user confirmed in the chat goes out without another prompt (0030).

## Decision
- A serenity MCP tool, **`send_reply`** (`session`, `text`), types the text into the session's pane as `y` on a reply suggestion does. It is pre-allowed. `suggest` is unchanged: kind `reply` stays for replies the chat proposes on its own, and `approve`, `cleanup` and `review` always wait for `y`.
- **The guard is mechanical, not the model's word.** `confirmedReply` sends at once only when the user's latest chat message contains the text as whole words (quote markers and whitespace aside), or answers a master reply that showed it: the same check as Slack (`confirmedSlackSend`). serenity's own messages to the chat (a watch fired, 0032) are never stored as the user's, so they confirm nothing.
- **Otherwise it falls back to NEEDS YOU**: the text becomes a pending `reply` suggestion (source `chat`), and the tool says so, so the chat tells the user it waits for `y` and shows the text. A following "just send it" then passes the check.
- **Live sessions only.** It refuses an ended or archived session, and one on a permission prompt, where keystrokes would land in the menu (suggest `approve` instead); a pane that has gone marks the session ended and refuses. A working session gets the text anyway: Claude Code queues typed input and reads it when its turn ends, as with `y` today. A send supersedes the session's pending suggestions.
- The skill and system prompt tell the chat to use `send_reply` when the user asks it to tell a session something, to show text it wrote and ask before sending, and to say whether it was sent or waits for `y`.

## Consequences
- Text from a session, a Slack message or a file cannot be sent without a `y` unless the user's own latest message contains it or confirmed it after seeing it.
- Whether the user's answer was a yes is the model's reading, as for Slack (0030); serenity proves only that they saw the exact text, or wrote it, and replied.
- A short reply the user typed ("tell it yes") goes out on the first turn; text the chat writes takes two turns, a draft and a confirm.
