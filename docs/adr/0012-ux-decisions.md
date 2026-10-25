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
| Master permission prompts | Shown in the master panel (0008); layout to design. |

## Consequences
- The spinner is the one animation; keep its tick cheap (no full canvas re-render).
