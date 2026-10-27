# 0012 · UX decisions not covered by the canvas

**Status:** Accepted · 2026-10-25 · revised 2026-10-26 (master overview sections)

The canvas's colours, frames, status language, card anatomy and keymap are final. These fill its "not designed yet" gaps.

| Topic | Decision |
|-------|----------|
| Launch outside tmux | Auto-create or attach the repo's tmux session and run inside it. |
| First run | Doctor checklist on first run only (tmux, claude, gh, git repo); then the master empty state: "press `n` to start your first session". `serenity doctor` re-runs it. |
| Smaller than 80×24 | Show a "terminal too small" message; no compact layout. |
| Colours | 16-colour ANSI, mapped as in the handover's colour table, so the user's terminal theme applies. |
| Master expanded (`M`) | Deferred to v1.1. |
| Watch (`f`) | `⚑` appears on the card; no toast. |
| WASD in an expanded topic (2b) | Superseded by 0017: there is no expanded topic. WASD moves between nodes (see Focus). |
| Keymap | Fixed in v1; no rebinding. |
| Failures | By severity: daemon or master down → red chip in the header; per-session problems (gh error, pane gone) → on that card. |
| Master busy | Spinner next to `◆ master`. |
| Config | JSON at `~/.config/serenity/config.json` (XDG). |
| Master permission prompts | Top of NEEDS YOU: "◆ master wants to use <tool>", the command below, `y` allow / `n` deny (0008). |
| `n` (design keymap conflict) | On an item with a pending suggestion `n` declines it; elsewhere it opens New session. `N` always opens New session. |
| Focus | (0026: the arrow keys move between nodes, and Enter goes into one.) One node has focus: the master or a card. WASD moves between nodes spatially (the master is reached with `A` from the left column, left with `D`); the focused node gets the heavy white frame. Focus starts on the master. |
| Arrow keys | (0026: `w` `s` do this once Enter has gone into the node.) `↑` `↓` select an element inside the focused node, marked `▸`. Master: its permission requests, NEEDS YOU items, then the input. Card: the card itself, the PR row, the master's suggestion (shown on the focused card), the input row. `Enter` acts on the selection: attach (card, NEEDS YOU item), open PR, accept the suggestion, start typing. |
| `y e n` target | The selected NEEDS YOU item when the master has focus, or the focused card's suggestion. `Tab` / `⇧Tab` focus the master and cycle through its requests, then NEEDS YOU. |
| `e` | Reply: edit the text in the card's input, Enter sends. Cleanup: open Confirm. Approve: attach to inspect the prompt first. |
| Archived sessions | Off the map; a topic whose sessions are all archived is gone from the map and from the topics the summarizer reuses. `H` opens the archived list, nested under each topic, newest first; `↑↓` scroll, `H` or `Esc` close. |
| Card order | Inside a topic: waiting on you, in progress, finished, then idle and ended. The topic holding focus keeps the order it was drawn in, so cards do not move under the cursor; it re-sorts once focus leaves. |
| `K` (kill) | Stops the agent after a `y`/`n` confirm and archives it. Unlike `x` it never touches the worktree or branch. Users do not create, rename or delete topics; only the master does. |
| Shortcuts panel | A fixed handful of rows; related keys share a row (`K x`, `N I`), so new keys do not grow it. |
| Conversation | The latest exchange (your message, the master's reply), a few lines each; the full history is `M` (v1.1). |
| Master overview | Between NEEDS YOU and CONVERSATION, as rows allow: **SLACK** (when the repo has Slack on, 0023: one thread or mention waiting on you, `[` `]` for the others; shown whole or not at all), **REVIEW** (open PRs in this repo asking for your review, newest updated first, at most 3: `#n title`, `@author age`), **MY PRS** (your open PRs from sessions on the map, at most 5, with the card's status word), **SESSIONS** (counts of the sessions on the map by status, then the 5 latest archived, `H` for all). NEEDS YOU, CONVERSATION and the input always show; the rows left over go to SLACK, then REVIEW, then MY PRS, then SESSIONS, each trimmed to fit or dropped. Empty sections take no rows. PR rows join `↑↓`; `Enter` or `o` opens the PR. |
| Master width | Between 38 and 64 columns: the terminal's width less 50. |

## Consequences
- The spinner is the one animation; keep its tick cheap (no full canvas re-render).
