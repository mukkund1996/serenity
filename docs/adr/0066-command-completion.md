# 0066 · `@copy`, `@handover` and `@move` lead on to what they need: sessions, then "to" and the topics

**Status:** Accepted · 2026-11-06 · Amends 0036, 0052, 0063

## Context
The master input's `@` list (0036) completes command words (0048) and live session names, but only after an `@`. A command then left the user to remember what comes next: `@copy` and `@handover` need `@session`, and `@move` needs sessions, then a topic, which the list never offered. Topics are a fixed set on the map, so typing one from memory risks a near-duplicate.

## Decision
- **One state machine in core.** `completionAt(before)` (`mentions.ts`) reads the text before the cursor and says what it completes. The last command in the text counts; `@new` takes no session, so it completes nothing.
  - `mention`: an `@query` being typed. As before: commands, then live sessions.
  - `session`: right after `@copy `, `@handover ` or `@move ` (exact, lowercase, then a space), before any session is named. The list opens at once with the live sessions, no second `@` needed. The bare word being typed filters them; a second word closes the list, as free text. Picking writes `@name `.
  - `brief`: `@copy @session `. No list; a dim hint after the cursor asks "what should the new session do?".
  - `to`: `@move @a ` (more sessions may follow, joined by `,` `and` `&`). No list; `@` adds another session as today. A dim hint says "@ another session, or space for a topic". Space or Tab writes `to `.
  - `topic`: `@move … to ` (or `into `). The list offers the map's topics, less `unsorted` and `pinned`, filtered by what follows "to" (starts-with first, then contains). Picking writes the topic's bare name and closes the list until the text changes. A name no topic matches is simply typed; creating it follows `maxTopics` and the near-duplicate rule as before (0047, 0063). With no topics at all, the hint says "a new topic's name".
  - `completionOptions` and `applyCompletion` give the list and the text a pick makes. The TUI only routes keys.
- **The list behaves the same in every state.** ↑ ↓ move, Tab or Enter pick, Esc closes it and keeps the text, it filters as you type, and it offers only live sessions. Shift+Enter still starts a line (0038), and a plain `@session` mention is unchanged.
- **Topics look like topics.** In the list a topic is bare (no `@`), in **sand** (`#d7af87`), labelled "topic" in gray. In the input the topic `@move` reads (`parseMove`, located by `moveTopicSpan`) takes the same sand, whether picked or typed, so the user sees what will be read as the topic. Sand is apart from every mention colour and the master's magenta.
- **No syntax change.** The master, its skill and `parseMove` read the same text as before; "to" was already dropped from a topic.

## Consequences
- Enter right after `@copy ` picks the first session rather than sending. Esc first closes the list (as for any open list).
- A topic is coloured from the parse, so a topic with extra words ("over to the release topic please") shows those words in sand too: the colouring shows the heuristic's reading (0063) before sending.
- The hint is drawn after the cursor only when the cursor is at the end of the text.
