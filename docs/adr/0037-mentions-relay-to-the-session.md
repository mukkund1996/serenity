# 0037 · An `@session` message is relayed to the session; the master never looks into it

**Status:** Accepted · 2026-10-29 · Amends [0036](0036-master-input-i-and-session-mentions.md)

## Context
0036 let the master act on a tagged session in two ways: analyse it itself (`session_status`, its PR, diff, `git log`, the repo, Slack threads) or message it. A question like "@api-auth why is CI red?" sent the master off reading code and checking out PRs, work the session's own agent already has the context for and does better. The user tags a session to talk to it, not to have the master investigate it.

## Decision
- **The master only relays.** For a session `@`-mentioned in the user's message, the master runs no `git`, `gh`, file reads, checkouts or Slack reads, and no `session_status` before sending. The session's agent does all the looking and reasoning.
- **The text is the user's message, lightly rewritten** to stand on its own: the `@name` dropped, "it" and "that" resolved from the chat or the snapshot (a Slack item as the snapshot shows it), nothing looked up added. It goes out with `send_reply`, at once, as in 0036.
- **An instruction** is sent, and the master says what it sent.
- **A question** is sent asking the session to answer, and the master calls `watch_session`. When the watch fires, the master condenses the session's last reply into its usual 3 sentences, adding nothing of its own (`session_status` only to read a reply cut short). A session that was working when asked fires at the end of that turn, before it read the question, so the master watches it again.
- **Enforced by the prompt and skill**, not by taking tools away: the master is one long-lived chat whose other turns still read the repo and Slack.

## Consequences
- Answers about a tagged session come from its own agent, and take as long as its turn; the master's reply in the meantime is just "asked, will relay".
- The model could still drift and read; a mechanical guard (tools withheld for a mention turn) is the next step if it does.
- Messages without a mention are unchanged: the master still reads the repo, PRs and Slack to answer them.
- The send gate of 0036 is unchanged: a mention lets `send_reply` go out at once; ended, archived and permission-prompt sessions are refused; Slack sends still need the draft and the user's confirmation.
