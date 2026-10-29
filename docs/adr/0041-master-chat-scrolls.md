# 0041 · The master shows four messages; `PgUp` `PgDn` scroll the conversation

**Status:** Accepted · 2026-10-29 · Amends [0012](0012-ux-decisions.md) (Conversation, Shortcuts panel)

## Context
The topics zoom's master panel showed only the latest exchange (0012): the user's message and the master's reply. A back-and-forth with the master, now that its input stays open (0036), loses the message before last at once, and a relayed answer (0037) can push the question that asked for it off the panel. The full history behind `M` is still v1.1.

## Decision
- **Up to four messages**, yours and the master's together, the latest at the bottom, each clipped to a few lines as before. When the panel is short of rows the oldest give way first, down to one; NEEDS YOU and the input never do, REVIEW takes what is left (0012).
- **`PgUp` steps back a message, `PgDn` on one.** `Shift+↑` `Shift+↓` do the same, for Apple Terminal, which keeps `PgUp` `PgDn` for its own scrollback. They work while the master has focus in the topics zoom, the input open or not; nothing else uses these keys. `↑` `↓` keep selecting the master's elements and the `@` list.
- **Hints.** `↑ N more · PgUp` above the messages when older ones are hidden; `↓ N newer · PgDn` below them once scrolled back.
- **The place is a message, not an offset.** Scrolled back, the panel keeps the same bottom message while the master answers, so the text being read does not move.
- **Leaving resets it.** Focus leaving the master, the zoom leaving topics, the input opening or closing, and sending a message all show the latest messages again.
- **The daemon sends the latest 50 messages** with the repo's state, up from 4, so there is something to scroll back to. Every state broadcast carries them; 50 keeps that bounded. Scrolling stops at the oldest of them; older history is still `M` (v1.1).
- The map zoom's master box still shows the last message only.

## Consequences
- The conversation takes more rows, so REVIEW is trimmed or dropped sooner on a short terminal.
- The shortcuts panel grows by one row (`PgUp PgDn`): no existing row has room for it.
