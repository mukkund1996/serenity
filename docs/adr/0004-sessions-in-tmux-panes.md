# 0004 · Claude Code sessions run in tmux panes

**Status:** Accepted · 2026-10-25

## Context
Session zoom shows the real, untouched Claude Code UI in the right ⅔ with the master floating on the left. Sessions must keep running after the map quits.

## Decision
- serenity runs inside a tmux session named per repo (e.g. `serenity-<repo>`). Run outside tmux, `serenity` creates or attaches that session (0012).
- Each Claude Code session is a `claude` process in its own tmux pane, parked in a hidden window when not attached.
- **Attach** (`Enter`): `join-pane` the session's pane into the serenity window, sized to the right ⅔; the serenity pane renders the session-zoom chrome and floating master on the left. **Detach** (`Ctrl+g`): move the pane back to its parking window.
- Replies (`i`, `y` on a reply suggestion) are delivered with `tmux send-keys`.
- The frame, title, PR and WAITING chip around the session pane are drawn by serenity's pane; tmux pane borders are styled or hidden to match.

## Consequences
- tmux is a hard dependency (≥ 3.2); the doctor check verifies it.
- `Ctrl+g` is bound in tmux (not in serenity) while a session is attached, because the session pane has focus.
- Exact frame alignment around a foreign pane needs a spike early in milestone 1.
