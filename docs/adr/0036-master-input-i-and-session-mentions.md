# 0036 · `i` opens the master input, which stays open; `@session` acts on a session at once

**Status:** Accepted · 2026-10-28 · Amended by [0037](0037-mentions-relay-to-the-session.md): the master relays to a mentioned session and never looks into it itself; by [0048](0048-at-new-starts-sessions-from-a-brief.md): `@` also completes command words, which are never session names

## Context
`g` opened the master chat from anywhere, while `i` already meant "message" on a session card, so the same job had two keys. The input also closed after every send, so a back-and-forth with the master took a key press per message, and one line was too little for a brief. And `send_reply` (0035) went out at once only when the user's message contained the text: for "tell api-auth to add tests" the master's own wording took a draft, a "Send it?" and a yes. When the user names the session in the message, that round trip says nothing the user has not already said.

## Decision
- **`i` opens the master input** when the master has focus; `g` no longer does. On a session card `i` still replies to that card. Inside the master, with a session in NEEDS YOU selected, `i` replies to that session as before; with nothing, a Slack item or the input row selected, it opens the master input. `Ctrl+g` (detach) is unchanged.
- **The input stays open after a send**: Enter sends and clears it, focus stays. Esc closes it. It grows to four lines as the text wraps; a longer message shows its last four.
- **`@` completes session names.** `@` and the letters after it, at the end of the text, list the live (not archived) sessions of the repo: names starting with the letters first, then names containing them. `↑` `↓` move, Tab or Enter put `@name ` into the text (Enter only while the list is open; otherwise it sends), Esc closes the list and keeps the input. The list is drawn over the rows above the input, in the map's master box and in the topics zoom's panel. Parsing, matching and completing live in core (`mentions.ts`), used by the TUI and the daemon.
- **A mention means "act on this session now".** The master's prompt and skill say: a session `@`-mentioned in the user's message is the subject; analyse it (`session_status`, PR, diff) or message it with `send_reply`, as the message implies, with no draft and no confirmation.
- **The gate is mechanical.** `send_reply` sends at once when the user's latest chat message `@`-mentions the target by its exact name, whatever text the master writes; otherwise the 0035 rules apply (exact text or confirmed draft, else NEEDS YOU). A name means the live session, as everywhere (`findSessionByName`): an archived twin is never the target. The target must be live, as for any `send_reply`: ended, archived and permission-prompt sessions are still refused.

## Consequences
- A tagged session gets whatever the master writes, so the user's trust is in the master's reading of the message. The mention is typed by the user, only the user's own latest message counts, and serenity's messages to the chat (a watch fired) are never stored as the user's, so no session, Slack message or file can grant it.
- Names are exact and case-sensitive: `@api` mentions nothing, which is why the list completes whole names. Text after a name (`@api-auth, please`) is not part of it.
- Slack sends still need the draft and the user's confirmation (0030); a mention does not widen them.
- `g` is free for other uses; the shortcuts panel and docs drop it.
