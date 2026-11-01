# 0053 · Ctrl+q back to the map, Ctrl+w to the master

**Status:** Accepted · 2026-11-01 · Amends [0004](0004-sessions-in-tmux-panes.md), [0026](0026-arrows-between-nodes-enter-into-ctrl-m-master.md) and [0051](0051-ctrl-g-always-reaches-serenity.md) (the keys, not how they are kept bound)

## Context

Leaving a session was `Ctrl+g` and focusing the master was `Ctrl+m`. `Ctrl+g` is also Claude Code's "edit the prompt in `$EDITOR`", so serenity took that key away from every agent pane, and 0051 was spent making sure it never leaked through. `Ctrl+m` is the same byte as Enter unless the terminal sends extended keys, so it needed tmux's `extkeys`, a CSI u key sent on to the map, and did nothing in Apple Terminal.

## Decision

- **`Ctrl+q` leaves a session for the map** (was `Ctrl+g`). **`Ctrl+w` focuses the master from every view** (was `Ctrl+m`); in a session it detaches first, as before.
- Both are plain control bytes, so they work without extended keys. The root bindings are as in 0051: in a pane carrying `@serenity_session` they run `serenity detach <pane>` (with `master` for `Ctrl+w`); anywhere else, the map pane included, they send the key on unchanged. The map reads `Ctrl+w` itself, so the CSI u form for the map pane is gone. Both cases of each key (`C-q` `C-Q`, `C-w` `C-W`) are bound for Caps Lock, and the daemon's 5 s check now looks for these four.
- **Binding removes serenity's old `C-g` `C-G` `C-m` `C-M`** from the root table when they still carry `@serenity_session`, so a tmux server that outlived the upgrade gives `Ctrl+g` back to claude. A user's own binding of those keys is left alone.

## Consequences

- `Ctrl+g` opens claude's editor again in an agent pane.
- `Ctrl+w` no longer deletes a word in claude's prompt inside serenity, nor in serenity's own text fields, where it now focuses the master. `Option+Backspace` still deletes a word in both. `Ctrl+w` in a plain shell pane is unchanged.
- `Ctrl+q` is XON under terminal flow control, but tmux reads the terminal raw, so it reaches the binding.
- The `@serenity_map` pane marker remains, for Shift+Enter (0038).
