# 0024 · Slack suggestions: replies from what serenity knows, or ask a session first

**Status:** Accepted · 2026-10-27

## Context
ADR 0023 shows the Slack threads and mentions waiting on the user. The answer to many of them is already on the map: a session's summary, its PR and checks, its branch, or something an agent knows but has not said. Typing that into Slack is the user's chore. Sometimes no card shows the answer, but an agent that did the work could give it if asked.

## Decision
- **One suggestion per Slack item, per repo.** When a read finds an item without one, Sonnet (the suggester, 0007) runs once with Slack's read tools, so it can read the thread. It also gets what serenity knows:
  - every session of the repo, archived ones included, with topic, status, branch, PR line and title, summary and task;
  - which sessions can be asked;
  - the PRs waiting for the user's review.
- **It returns one of:**
  - **reply:** the text the user would post in the thread.
  - **ask:** a question for a session that can be asked: its agent is alive and free (idle, done, or waiting on a question; not working, not on a permission prompt).
  - **none:** nothing in serenity bears on the message (small talk, meetings, someone else's question).
- **Shown under the item** as `◆ <label>` with `y e n`, in the SLACK section and in the map's Slack box. `[` `]` move between items, and each shows its own suggestion.
- **`y` on an ask** types the question into the session, as a reply does. The line turns to "Asked <session>; waiting for its answer". When the session's next reply arrives (its `Stop`), the suggester runs again with the question and the answer, and may only propose a reply.
- **`y` on a reply posts it in the thread.** The token is the `claude` CLI's (0023), so a one-shot Haiku call does the posting. It is allowed exactly one tool, `slack_send_message`, and is told to send the text verbatim; it returns whether Slack took it. A failed send keeps the suggestion to try again. After sending, Slack is read again, so the item leaves the inbox.
- **`e`** edits the reply text (or the question) in the reply input first; `Enter` then does what `y` does.
- **`n`** declines. The item is not suggested again until someone writes in its thread (a newer message), which also replaces a pending suggestion.
- **Kept in memory,** not in the suggestions table: Slack items are not sessions, and they are re-read every minute. A daemon restart suggests again from the next read.

## Consequences
- One Sonnet call per new item per open repo with Slack on, plus one per answered question, and one Haiku call per sent reply.
- Posting through a model breaks 0008's rule that executors are deterministic. The tool allow-list, the verbatim instruction and the result check bound the risk. The user sees the text before `y`, and `e` lets them change it.
- Only a session that can take input can be asked. Archived and ended sessions inform replies through their summaries and PRs, but cannot be asked.
