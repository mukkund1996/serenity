# 0052 · `@` mentions are coloured by what they resolve to: sessions blue, `@new` green, `@copy` and `@handover` yellow

**Status:** Accepted · 2026-11-01 · Builds on 0036, 0048, 0049

## Context
The master's input mixes three kinds of `@word`: a session's name (0036), which the master acts on directly; `@new` (0048), which starts sessions; and `@copy` / `@handover` (0049), which ask a session for a handover doc. All of them look the same as plain text, so it is hard to see at a glance whether a message names the right session, or whether a word is a command at all, before sending it. A typo like `@api-auht` looks just as valid as `@api-auth`.

## Decision
- **Colour an `@word` only when it resolves**, by the same rules the daemon reads it with. A command word is exact and lowercase (`masterCommands`); a session name is a live session's exact name (`mentionedSessions`). Punctuation after either stays plain. An unknown, archived-only, half-typed or miscased `@word` stays plain, so a word that will do nothing looks like it.
- **Colours** (`MENTION_COLOR` in the TUI's theme):
  - a session: `blueBright`. Plain `blue` is hard to read on many dark terminal themes.
  - `@new`: `green`, for starting something.
  - `@copy` and `@handover`: `yellow`. They are the same handover-doc family (0049), so they share a colour.
- **Where:** the text being typed in the master's input (in the master panel and in the map's master box), the `@` list (only the `@name`; the selected row keeps its `▸` marker and goes bold, so it stays easy to spot), and the user's own messages in the conversation and as the map's last message. The master's replies are not coloured.
- **One classifier.** `mentionSegments(text, sessions)` in core cuts a text into plain text and resolving `@word`s. It shares the session lookup with `mentionedSessions`, so a colour never claims a mention the daemon would not act on.

## Consequences
- A session name turns blue only once it is typed in full. While it is half typed, the `@` list shows the candidates in their colours instead.
- A session that is archived after a message was sent loses its colour in that message's history. The history shows what the mention means now, not what it meant then.
- Yellow is also NEEDS YOU's colour and the waiting glyph's, and blue the working glyph's. They show up in different places (section headers and glyphs, not inside text), so they are hard to confuse.
