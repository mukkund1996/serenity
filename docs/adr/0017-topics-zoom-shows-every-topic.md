# 0017 · The topics zoom shows every topic

**Status:** Accepted · 2026-10-25

## Context
The design canvas (handover, screens 2 and 2b) shows only the two topics that need the most attention, with at most 3 cards each. The rest of the topics collapse into a dashed "N more topics" node. Enter on the node swaps a topic in, `+` expands one to 9 cards, and `]` pages through the cards that don't fit. In use, this hides sessions behind extra keys and moves bubbles around when attention changes.

The master assigns each session a topic (0007). Code and docs called these "categories", but the domain term is **topic**, as in the name of the zoom.

## Decision
- **Every topic, every card.** The topics zoom draws a bubble for each topic, ranked by attention as before, and puts all of the topic's sessions in it. The "N more topics" node, the 3-card cap, `+N more`, expand (2b) and in-topic paging are dropped.
- **Scroll to focus.** A stack that fits is centred on the master's row, as before. A taller stack scrolls so the focused card sits in the middle. `▲` / `▼` on the trunk show that more is above or below.
- **`[` / `]` cycle topics.** They move focus to the first card of the previous or next topic and wrap around. From the master, either key goes to the first topic. WASD still moves between nodes, and `Tab` still cycles NEEDS YOU (0012).
- **Master stays docked left.** The suggestion was to place topics all round a centred-left master. We didn't do that because the master panel is an Ink box of varying height (0003), so topics above and below it would need a reserved block and links routed around it. Topics stack to the master's right.
- **"Topic" everywhere.** Types, the session fields (`topic`, `topicCandidate`), the summarizer's JSON (`{ summary, ask, finished, topic }`) and the MCP tool (`set_topic`) all use "topic". Sessions saved with `category` are read back as `topic`.

## Consequences
- Nothing is hidden behind a key. A repo with many sessions scrolls instead of paging.
- The handover's screen 2b and its "Which topics show" rules no longer apply. Where they disagree with this ADR, this ADR wins.
- The map zoom (screen 1, milestone 4) keeps its own per-bubble limit. This decision covers the topics zoom only.
- The Opus chat's MCP tool is renamed, so its allow-list (`--allowedTools`, 0008) lists `mcp__serenity__set_topic`.
