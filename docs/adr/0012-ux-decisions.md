# 0012 · UX decisions not covered by the canvas

**Status:** Accepted · 2026-10-25

The canvas's colours, frames, status language, card anatomy and keymap are final. These fill its "not designed yet" gaps.

| Topic | Decision |
|-------|----------|
| Launch outside tmux | Auto-create or attach the repo's tmux session and run inside it. |
| First run | Doctor checklist on first run only (tmux, claude, gh, git repo); then the master empty state: "press `n` to start your first session". `serenity doctor` re-runs it. |
| Smaller than 80×24 | Show a "terminal too small" message; no compact layout. |
| Colours | 16-colour ANSI, mapped as in the handover's colour table, so the user's terminal theme applies. |
| Master expanded (`M`) | Deferred to v1.1. |
| Watch (`f`) | `⚑` appears on the card; no toast. |
| WASD in an expanded category (2b) | Moves between cards inside the category; `Esc` leaves it. |
| Keymap | Fixed in v1; no rebinding. |
| Failures | By severity: daemon or master down → red chip in the header; per-session problems (gh error, pane gone) → on that card. |
| Master busy | Spinner next to `◆ master`. |
| Config | JSON at `~/.config/serenity/config.json` (XDG). |
| Master permission prompts | Top of NEEDS YOU: "◆ master wants to use <tool>", the command below, `y` allow / `n` deny (0008). |
| `n` (design keymap conflict) | On an item with a pending suggestion `n` declines it; elsewhere it opens New session. `N` always opens New session. |
| `y e n` target | The selected NEEDS YOU item: `Tab` / `⇧Tab` cycle through the master's requests, then NEEDS YOU; WASD selects cards. |
| `e` | Reply: edit the text in the card's input, Enter sends. Cleanup: open Confirm. Approve: attach to inspect the prompt first. |
| Conversation | The latest exchange (your message, the master's reply), a few lines each; the full history is `M` (v1.1). |

## Consequences
- The spinner is the one animation; keep its tick cheap (no full canvas re-render).
