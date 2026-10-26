# 0018 · Map zoom and navigation keys

**Status:** Accepted · 2026-10-26

## Context
Milestone 4 adds the map zoom (handover screen 1) and the keys that move around it: `z` / `Z`, `Esc`, `c`, `/` and `r`. The canvas shows the map with a handful of topics around a centred master. It does not say where bubbles go when there are many, what the master box holds, or what `/` matches.

## Decision
- **One canvas.** The map zoom draws the master box into the cell canvas too, at a fixed 8 rows: its status line, the selected NEEDS YOU item or else the latest message, and its input. The topics zoom keeps the Ink master panel (0017). Because the box has a fixed height, topics can sit on both sides of it.
- **Two columns.** Bubbles fill a column left and a column right of the master, neediest first, each into the shorter column. Each column centres on the master's link row and scrolls to the focused row when it is taller than the screen, as the topics zoom does. There are no bubbles above or below the master: at 80 × 24 they would not fit.
- **Rows.** One line per agent: `▸`, glyph, name, `⚑`. Waiting rows are inverse yellow. A bubble lists 5 agents, then `+N more`. A focused agent past the fold is swapped in for the fifth row, so focus is never hidden. The focused row shows the master's suggestion under it, and `i` opens a reply row there. `↑` `↓` step through the row, its suggestion and its reply; there is no PR row because the map shows no PRs.
- **Same keys in both zooms.** (0019 changes WASD and `↑` `↓` on the map to move between and within topics.) WASD, `Tab`, `[` `]`, `y e n`, `i`, `r`, `K`, `x` and Enter behave the same on the map. `Tab` focuses the master and its box shows the selected item.
- **`z` / `Z` / `Esc`.** `z` goes to the topics zoom and `Z` to the map (swapped by 0019: `z` out to the map, `Z` in to topics). `Esc` goes up one level: session › topics › map. The map is the top level, so `Esc` does nothing there. Focus stays on the same node when the zoom changes.
- **`c`** focuses the master: it is in the centre on the map and docked left on topics.
- **`/` search** matches session names, topics and branches as you type. Focus jumps to the first hit, `Tab` / `↑` `↓` cycle through hits, Enter keeps the focus and `Esc` puts it back where it was. The query lives in the footer instead of a dialog.
- **`r` rename** renames the focused session (`session.rename`). The new name follows the same rules as New session and must not clash with a live session. A session serenity spawned also gets its tmux window renamed. An imported session's window belongs to the user, so it keeps its name. Branches and worktrees keep their names. Topics have no rename (0012).

## Consequences
- The map zoom has no NEEDS YOU list. Only the selected item shows, so `Tab` is the way to walk it.
- The footer lists `WASD`, `c`, `z Z`, `/` and `g`. `↑↓` and `[ ]` move from the footer into the shortcuts panel, which grows by that one row. `r` joins `K x`, and `Tab Esc H` share a row.
