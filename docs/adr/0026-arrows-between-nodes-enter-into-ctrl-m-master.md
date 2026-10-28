# 0026 · Arrow keys between nodes, Enter into a node, `Ctrl+m` to the master

**Status:** Accepted · 2026-10-27 · Enter into a card superseded by 0028; `g` for the master chat replaced by `i` in 0036

## Context
WASD moved between nodes and the arrow keys selected inside the focused node (0012, 0019). Arrow keys are what people reach for to move around, and having both key sets live at once meant any stray `↑` changed the selection inside a node you had only passed through. The way back to the master was `c` on the map, `Ctrl+g` and then `c` from a session.

## Decision
- **The arrow keys move between nodes.** On the map they move between topics. In the topics zoom they move between cards and the master. This is the job WASD had (0019).
- **Enter goes into the focused node.** Outside a node the frame shows focus and nothing inside it is selected: no `▸`. Inside it, `w` `s` step through its elements, which is the job `↑` `↓` had: the master's requests, NEEDS YOU, PR rows and input; a card's PR, suggestion and reply. On the map they also step to the next agent in the bubble. Enter acts on the selection as before, so attaching from outside a card takes Enter twice, or `Z` once. `a` `d` do nothing.
- **Esc leaves the node.** Focus stays on it. Outside a node, Esc goes up a level as before (topics › map). `Tab`, `i` and `e` go into the node they act on.
- **`Ctrl+m` focuses the master from every view.** On the map and in topics it closes any overlay or text input. In the session zoom it detaches the session first. The master gets focus with nothing selected inside it.
- **How `Ctrl+m` gets through.** A terminal sends `Ctrl+m` and Enter as the same byte, CR, unless it sends extended keys. tmux asks the terminal for them (`extended-keys`, the `extkeys` feature) and then reports `C-m` apart from `Enter`. serenity binds `C-m` in tmux's root table beside `C-g`. In an agent pane (`@serenity_session`) the binding runs `serenity detach <pane> master`: the daemon detaches the session, selects the map pane and sends it `Ctrl+m`. In the map pane (`@serenity_map`, set when the map subscribes) it sends `ESC [109;5u`, which Ink reads as `ctrl+m`. In any other pane it sends `C-m` on, unchanged.

## Consequences
- In a terminal without extended keys (Apple Terminal) `Ctrl+m` is Enter. `c` still focuses the master on the map, and `Ctrl+g` still leaves a session.
- The binding lives in the tmux server, so it also covers the user's own panes. There it only passes `C-m` through. The map pane's mark is cleared when the map disconnects, so a shell left in that pane gets plain Enter again.
- The footer reads `←↑↓→ move · Enter into · Ctrl+m master · z Z zoom · / search`. `c` and `g` move to the shortcuts panel (`g` became `i` on the master, 0036). Its ON A NODE section grows by one row.
