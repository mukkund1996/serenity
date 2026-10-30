# 0050 · NEEDS YOU: Enter marks an item seen, ◆ says what `y` does to whom, and Slack follow-ups tell a session or start one

**Status:** Accepted · 2026-10-30 · Amends 0024, 0031, 0034, 0040

## Context
NEEDS YOU mixes sessions and Slack items (0031), each with a ◆ suggestion. Three things made it harder to use than it should be:

- The ◆ line was the model's own label (`Reply "yes"`, `Ask api-auth if it shipped`). It did not say where a reply goes or what `y` will run, and the full text was never shown.
- A Slack mention or DM the user had already read and handled on Slack stayed until the worker's triage dropped it, or until `x`. Enter only opened it.
- The Slack suggester (0024) could propose a reply or a question for a session. It could not hand the request to the session the message is about, or start a session for new work, which is often what a Slack ask needs.

Slack's MCP server, serenity's only way into Slack (0023), gives no read state: no `last_read`, no unread counts, no `conversations.info`. Its token belongs to Claude Code's Slack plugin client, so serenity cannot ask for more scopes. A separate Slack app and user token was considered and rejected for now: it is another login to set up and keep.

## Decision
- **Read on Slack means you wrote after it.** The inbox worker also returns `lastOwnTs` for each item: the user's newest message where they would have seen it. For a DM that is anything they wrote in it. For a message in a thread it is their newest reply in that thread. For a top-level channel message it is their newest top-level message in that channel. The parser drops an item whose `lastOwnTs` is later than its ts. Every poll reads Slack again, so an item goes as soon as the user writes after it. Thread mentions count only replies in that thread, since Slack does not say whether a thread was read.
- **Enter marks a NEEDS YOU item seen.**
  - A Slack item is dismissed, as `x` does (0034, kept in `slack_dismissals`), and also opened in Slack. `o` still only opens it.
  - A session is dismissed with the new `session.dismiss`, which sets `dismissedAt` (kept in the session row). A watched session that finished also loses its watch. It stays out of NEEDS YOU until its status changes or a suggestion newer than the dismissal comes. Its card stays on the map.
  - A session waiting on a permission prompt or a question is never dismissed, because hiding a blocked agent would stall it. Enter attaches to it, as before.
  - `y` still runs the ◆ suggestion.
- **The ◆ line says what `y` does and to whom.** It is a verb and a target, then the text: `Reply in #eng thread: …`, `Reply to Dana in DM: …`, `Tell api-auth: …`, `Start new session fix-login: …`, `Approve in api-auth: …`, `Clean up api-auth: …`, `Request review on api-auth: @alice`. serenity builds it from the suggestion's kind and target, not from the model's label. It wraps to two lines, and on the selected item it shows in full (up to 12 lines). After `y` it says what it waits on: `Told api-auth; waiting for its answer`. The source still heads each item (`@ Dana in #eng` or the session's name), with what it needs under it. The verb names Slack where it goes there, so the cyan `slack` tag of 0040 is gone.
- **Slack follow-ups: reply, tell, or start.** The suggester returns one of:
  - **reply:** text to post. A DM's own message is answered in the DM, anything else in its thread.
  - **tell:** a message for the session the item is about, if that session can take input (0024's rule): either to get an answer it holds or to have it do what was asked. This replaces `ask`.
  - **start:** a new session's name and a brief, for new work that no session covers. `y` starts it like `N` does (a worktree off the default base), with the brief as its first prompt.
  - **none.**

  It prefers reply, then tell, then start. After a tell or a start, the session's next answer brings a reply suggestion (0024's follow-up), and only a reply is taken then.
- **Matching items to sessions.** The context gives each session's PR URL as well as its number. serenity also lists the sessions the message names by session name, branch, PR number (`#42`) or PR link, and the suggester checks those first.

## Consequences
- "Read" is a proxy. A message the user read but did not answer stays until they write in that DM, thread or channel, or press Enter or `x`. Real read state would need a Slack app of serenity's own.
- `lastOwnTs` is the model's reading of Slack, like the triage (0031). A wrong one hides an item early or keeps it.
- Enter on a session no longer attaches unless the session waits on the user. `Z` in the topics zoom, or Enter on its card, still attaches.
- `start` creates a worktree and a branch on `y`, a heavier action than a reply, so the ◆ line spells out the new session's name before the user presses it.
