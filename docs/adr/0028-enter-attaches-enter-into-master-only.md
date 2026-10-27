# 0028 · Enter attaches a card; only the master is gone into

**Status:** Accepted · 2026-10-27

## Context
0026 made Enter go into the focused node, with `w` `s` selecting inside it and Enter acting on the selection. On a card that meant two Enters to attach, which is the one thing you nearly always want from a card, and it got in the way in the topics zoom. A card's other rows already have their own keys: `i` to message the agent, `y` `e` `n` on its suggestion, `o` for its PR. Only the master has a list worth selecting through. The topics zoom's card frames, in light status colours, pulled the eye away from the master. Stepping through Slack items with `[` `]` could skip items when two presses landed before a render, could land on a different message when new ones arrived, and could drop the SLACK section when the next item had a suggestion and the current one did not.

## Decision
- **Cards: Enter attaches, `i` sends a quick message.** There is no going into a card. This undoes 0026 for cards.
- **The master: Enter goes in, Esc leaves.** Inside it `↑` `↓` and `w` `s` select its elements, marked `▸`, and Enter acts on the selection as before. `←` `→` `a` `d` leave it for the node on that side. Outside it nothing in it is selected, so `y` `n` `[` `]` act on nothing there.
- **WASD moves between nodes again, beside the arrow keys.** In the topics zoom both move spatially between cards and the master. On the map `←` `→` `a` `d` move between topics, and `↑` `↓` `w` `s` step through the agents of the focused bubble, on to the bubble above or below past either end.
- **Duller card frames.** An unfocused card's frame and status glyph take their status colour, dimmed. The focused card stays heavy white.
- **Slack keeps its place.** The item shown is tracked by id, `[` `]` step from the latest press, and the SLACK section is sized for its tallest item, so stepping never drops it.
- **MY PRS is off for now.** The master panel shows SLACK, then REVIEW.

## Consequences
- The footer reads `←↑↓→ WASD move · Enter open · i message · Ctrl+m master · z Z zoom · / search`.
- A card's PR and suggestion rows can no longer be selected; `o` and `y` `e` `n` act on them.
- `myPullRequests` stays in core for when MY PRS returns.
