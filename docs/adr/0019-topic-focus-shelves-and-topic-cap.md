# 0019 · Topic focus on the map, shelves in the topics zoom, a topic cap, roomier master and cards

**Status:** Accepted · 2026-10-26

## Context
Using milestone 4 turned up six problems. On the map, WASD stepped one agent row at a time, so crossing a busy bubble took many presses and nothing showed which topic you were in. `z` went in to topics and `Z` out to the map, the opposite of what people reach for. The topics zoom stacked every bubble in one column, so a wide terminal showed a tall strip with empty space beside it. The summarizer opened a new topic for almost every session, so the map filled with one-session bubbles. In the topics zoom, the master panel cut NEEDS YOU asks and suggestions to one line and its section headings blended into the rows, and every card cut its text to two rows.

## Decision
- **WASD moves between topics on the map.** (0023 moves this to the arrow keys, and `↑` `↓` inside a bubble to `w` `s` after Enter.) Focus lands on the agent last focused in that topic, or its first agent. The bubble holding focus gets the heavy white frame and a bold title. `↑` `↓` move inside the bubble: through the focused agent's rows (it, its suggestion, its reply), then on to the next or previous agent. The master is still reached with WASD and still uses `↑` `↓` for its own items. The topics zoom keeps WASD between cards (0012).
- **`z` zooms out to the map, `Z` zooms in to topics.** This replaces the keys in 0018. `Esc` still goes one level up.
- **Shelves in the topics zoom.** Bubbles fill rows ("shelves") left to right, neediest first. Each bubble goes on the first shelf with room for it, so a small topic can sit beside an earlier one. A shelf hangs off a bus on the row above it. The bus joins the trunk, and each bubble drops from the bus onto a `●` in its top border. The rest is unchanged: a bubble is as many cards wide as fit, up to its session count, and a stack taller than the screen scrolls to the focused card (0017).
- **At most `maxTopics` topics per repo** (config, default 10). The summarizer's prompt says to strongly prefer an existing topic, even a loose fit, over creating a new one. Once a repo has `maxTopics` topics, the summarizer's JSON schema limits `topic` to the existing names. A new name proposed past the cap is dropped anyway, as a guard. The chat's `set_topic` refuses a new name past the cap and lists the existing topics. Moving a topic's last session to a new name is allowed, because the count stays the same.
- **A roomier master panel.** It is up to 72 columns wide (was 64). A NEEDS YOU item's ask (or a permission's detail) and its suggestion each wrap to 2 lines instead of being cut, and a blank row separates items. Section headings sit on a filled chip: yellow for NEEDS YOU, gray for the rest.
- **Cards fit their text.** A card is as tall as its text needs, up to 4 rows under the PR line: the summary, or your prompt and then Claude's reply or the ask. Cards in a row of a bubble share the tallest one's height. To keep summaries to 4 rows of a 36-column card, the summarizer is asked for a compact one of at most 130 characters (was 160).

## Consequences
- Topics that existed before the cap stay. Nothing merges them. Past the cap, sessions can only join existing topics, so the count can fall as old sessions are archived but cannot grow.
- The handover keymap and README follow the new `z` / `Z`.
- The master panel shows fewer items in the same height, since items take more rows. Past the 5-item window, `+N more` and scrolling are unchanged.
