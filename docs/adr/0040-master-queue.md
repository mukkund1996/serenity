# 0040 · The master's queue: replies it wants to send wait in their own section, not NEEDS YOU

**Status:** Accepted · 2026-10-29 · Amends 0031, 0035

## Context
A reply the master's chat drafts for a session (`suggest` kind `reply`, or a `send_reply` the user had not confirmed, 0035) waited in NEEDS YOU as the session's ◆ suggestion. NEEDS YOU is for what sessions and people need from the user; these are the master's own outgoing messages. Mixed in, they made an idle session look like it needed the user, took one of the five NEEDS YOU places, and showed only a 60-character label of a message that can run to paragraphs.

## Decision
- **A queue section in the master.** A pending suggestion of kind `reply` with source `chat` is *queued* (`isQueued`, `masterQueue` in core). The topics zoom's panel draws them under NEEDS YOU, as `QUEUE N`, on a coral chip (`QUEUE_COLOR` in the theme) apart from NEEDS YOU's yellow and the master's magenta. One line each: `→`, the target session, a preview of the text cut to the row, and `y e n`. At most three show; the rest are `+N more`, and the window slides to keep the selection shown, as NEEDS YOU's does.
- **Enter shows the whole message** under its line, its own line breaks kept, up to 12 lines; Enter again folds it. `y` sends it as before (`suggestion.accept`), `e` edits it, `n` or `x` drops it. ↑↓ and Tab reach queued replies after NEEDS YOU's items.
- **NEEDS YOU leaves them out.** A queued reply does not put its session in NEEDS YOU or show as its ◆ line; a session that is waiting still shows there, without it. Worker suggestions (source `worker`) and the chat's `approve`, `cleanup` and `review` stay in NEEDS YOU. On a topic card, a queued reply still shows as the card's suggestion, and `y` there sends it.
- **The map's master box** shows a selected queued reply like a NEEDS YOU item (target, two lines of the text, its keys), and its status line adds `· N queued`.
- **Slack drafts stay in NEEDS YOU**, under the Slack item they answer, but their ◆ line is marked `slack` (`SLACK_COLOR`), so a message that goes to Slack is told apart from one that goes to a session.
- The master's prompt, skill and tool descriptions say an unconfirmed reply waits in the master's queue.

## Consequences
- "N things need you" counts only what needs the user; the queue is counted in its own header (and on the map's status line).
- The queue is rows the conversation and REVIEW no longer get; it is capped at three lines while folded so it cannot crowd them out.
- Nothing changes in the daemon: queued replies are the same suggestions, accepted and declined through the same RPCs.
