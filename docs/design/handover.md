# Design handover

Copied from the design canvas "Agent Mind Map CLI — Screens" ([source](https://claude.ai/artifact/8c7QCT22YmUoADtsrzU6i7)) on 2026-10-25. The canvas artboards are the screen specs; this file holds the decisions written on it. The canvas's "suggested architecture" is replaced by the ADRs in [`docs/adr/`](../adr/README.md), and its "not designed yet" items are resolved in [ADR 0012](../adr/0012-ux-decisions.md) where noted.

## Principles
- **Focus and peace of mind.** Only what needs you asks for attention; everything else stays quiet and grey.
- **Simple, clean, progressive disclosure.** No persistent key bar, no timers, no counts that don't lead to an action. Details appear on focus or behind a key.
- **Master always visible**, in every zoom level, never replaced by another view.
- **Terminal-true.** Everything is cells, box-drawing characters and ANSI colours. No mouse.

## Screens
| Artboard | What it specifies |
|----------|-------------------|
| `1 · Zoom: map` | Lowest zoom. Master box in the centre (status line, latest message to or from the master, input). Categories as rounded bubbles around it, joined by right-angle links. One line per agent: cursor `▸`, glyph, name, `⚑` if watched. Waiting rows are inverse yellow. At most ~5 agents per bubble, then `+N more`. No PR info here. |
| `2 · Zoom: topics` | Default view. Master panel docked left and vertically centred on its trunk. Only the **2 categories that need the most attention** are shown. Bubbles are a grid of 40-col cards and size to their content (one column when it fits). Calm categories collapse into the dashed `N more categories` node at the bottom; Enter on one brings it in and the first category steps out. |
| `2b · infra expanded` | `+` on a category grows it to up to 9 agents (3×3), then `+N more`; `]` shows the next ones, `Esc` collapses. The other categories move into the node. |
| `3 · Zoom: session` | The real Claude Code pane, untouched, in the right ⅔, framed in the status colour with name, PR and WAITING chip on its top border. Master floats left (not full height): "about this session" with a one-key suggested reply, then the other sessions that need you. `Ctrl+g` back to the map. |
| `4a · Reply` | `i` focuses the card's input row. `Tab` in the input opens recent replies; the master's pick is first and highlighted. |
| `4b · Confirm` | Opens on `x`, on `e` for a cleanup suggestion, or when `y` is pressed but something is unsafe. Lists every step plus a safety line (uncommitted changes, unpushed commits, PR merged). |
| `4c · Slack draft` | **v2.** Only when the master decides a message is worth sending. Destination, why, editable text. Nothing is sent without `y`. |
| `4d · New session` | Name, working dir, new worktree or existing branch. No category field: the master places the node. |
| `4e · Shortcuts` | `?` toggles a small panel at the bottom right. The only place the full keymap and legend live. |

## Master behaviour
- **NEEDS YOU** is the master's core list. Each session gets exactly three lines: status glyph + name; one grey line with what the agent asks or its state; one `◆` suggestion with `y` / `e` / `n`.
- Order: watched-and-finished first, then waiting, then others that need an action.
- Suggestion kinds: reply to the agent, approve a request, clean up, request a review from a teammate (v1: via `gh`; Slack note is v2).
- **Watch** (`f`) is only a reminder flag: when the agent finishes it jumps to the top of NEEDS YOU.
- The master assigns and moves categories itself; the user never defines them.
- Below the list: the latest exchange with the master and its input. No activity log on screen; history belongs behind `M` (v1.1).

## Which categories show (topics zoom)
- Rank by attention: waiting sessions, then dead or failing PRs, then finished-and-watched.
- Show the top 2. The rest are listed in the dashed node, ranked the same way, with their counts.
- Selecting a category in the node swaps it in for the first visible one.
- A category shows at most 3 cards collapsed, 9 expanded; the rest are `+N more` and cycle with `]`.

## Zoom levels
`map` › `topics` › `session`. The current level is always shown top right (`zoom: topics`). `Esc` goes one level up; inside a session use `Ctrl+g` because Esc belongs to Claude Code.

## Status language
| State | Shown as |
|-------|----------|
| waiting | `◐` yellow · card frame yellow · inverse `WAITING` chip |
| in progress | `●` blue |
| finished | `✓` green |
| idle | no glyph · name in grey-blue |
| dead | no glyph · resume via the master |
| archived | no glyph · name in faint grey, stays in its category |

Only these three glyphs exist. PR status is words only: checks failing (red), checks running, checks passing (green), approved (green), merged (cyan), draft. Category labels show counts as `infra · ◐1 ●5 ✓1` or `quiet`.

## Card anatomy (topics zoom, 40 cols)
- Top border: `◐ name` on the left; `⚑` and/or WAITING chip on the right.
- Row 1: `PR #482` (underlined, `o` opens it) + status word, or `no PR yet`.
- Rows 2–3: master's 1–2 sentence summary in grey.
- Focused only: last message (`you ›` cyan or `◆ master ›` magenta, text in white), then the input row `› █` on a dark highlight.
- Focus = heavy white frame `┏━┓`. Waiting = yellow light frame. Others = grey light frame.

## Header and footer
Header: `◆ mindmap  <repo>` · centred inverse-yellow `4 need you` · `zoom: …`. Footer: `WASD move · c center on master` left, `? shortcuts` always bottom right.

## Frames and grid
| Element | Characters |
|---------|------------|
| agent card | `┌─┐ │ └─┘` |
| focused card | `┏━┓ ┃ ┗━┛` white |
| category bubble, master | `╭─╮ │ ╰─╯` |
| more-categories node | `┌╌┐ ╎ └╌┘` |
| dialogs | `╔═╗ ║ ╚═╝` + 1-cell black drop shadow |
| links from master | `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴`, end dot `●` |

Titles sit on the top border with one space either side. Design target 200 × 50 cells; must work at 80 × 24. On the canvas 1 column = `1ch` and 1 row = `17px`, so positions read directly as cells.

## Colours (16-colour ANSI)
| Role | Design hex | ANSI |
|------|-----------|------|
| background | #0d0f12 | default bg |
| header · panel | #161a1f · #0f1216 | black 0 |
| text | #d0d4da | default fg |
| secondary · summary | #858c97 | bright black 8 |
| frames | #3a3f47 | bright black 8, dim |
| waiting | #f2c14e | yellow 3/11 |
| in progress | #6cb0f0 | blue 4/12 |
| finished · passing | #7fc77f | green 2/10 |
| idle name | #8b95a7 | white 7, dim |
| failing | #f07070 | red 1/9 |
| merged · "you" | #5cc8c8 | cyan 6/14 |
| master · ◆ | #c792ea (links #8a6fae) | magenta 5/13 |

Status never relies on colour alone except idle and archived, which are deliberately quiet.

## Keymap (final)
**Move**
| Key | Action |
|-----|--------|
| `Tab` `⇧Tab` | next / previous waiting |
| `W A S D` | move around the map (inside an expanded category: between its cards) |
| `c` | center on master |
| `z` `Z` | topics / map zoom |
| `+` · `Esc` | expand category · one level up |
| `[` `]` | previous / next agents in a category |
| `/` | search nodes |

**On a node**
| Key | Action |
|-----|--------|
| `i` | reply · `Tab` opens recent replies |
| `Enter` | attach · `Ctrl+g` back |
| `o` | open PR |
| `f` | watch (remind master when done) |
| `n` `r` `x` | new · rename · remove |

**Master and global**
| Key | Action |
|-----|--------|
| `g` · `M` | message master · expand master (v1.1) |
| `y` `e` `n` | approve · edit / inspect · decline a suggestion |
| `?` | shortcuts panel (`Ctrl+g ?` inside a session) |
| `q` | quit the map; sessions keep running |

## Data model sketch
```
Session {
  id, name, category, tmuxPane, worktree, branch
  status: waiting | working | idle | done | dead | archived
  pr?: { number, url, state, checks, reviews }
  summary        // ≤ 2 sentences, written by master
  ask            // one line: what the agent needs
  lastMessage: { from: "you" | "master", text }
  watched: boolean
  suggestion?: { kind: reply | approve | cleanup | review,
                 label, actions: [y, e, n] }
}
Category { name, sessions[], attention }   // master-owned
Master   { status, conversation[], needsYou: Session[] }
```

## Not designed on the canvas
| Item | Where it stands |
|------|-----------------|
| Master expanded view (`M`) | Deferred to v1.1 (ADR 0012) |
| Compact fallback below 80 × 24 | "Too small" message instead (ADR 0012) |
| Empty map on first launch | Doctor on first run, then master empty state (ADR 0012) |
| Importing existing tmux sessions | Out of v1 (ADR 0001) |
| Master busy | Spinner (ADR 0012) |
| Failures | Header chip or on-card, by severity (ADR 0012) |
| Watch confirmation | `⚑` only (ADR 0012) |
| What counts as "finished" | `Stop` hook + Haiku judgement (ADR 0006, 0007) |
| WASD in an expanded category | Moves between its cards (ADR 0012) |
| Master permission prompt | Needs a design (ADR 0008) |
