# 0054 · The agent-pane test compares the marker with empty; the binding check keeps trying

**Status:** Accepted · 2026-11-01 · Amends [0051](0051-ctrl-g-always-reaches-serenity.md) and [0053](0053-ctrl-q-and-ctrl-w.md) (the binding's condition and the binding check)

## Context

The root bindings for `Ctrl+q` and `Ctrl+w` ran `if-shell -F "#{@serenity_session}"`: detach in a pane carrying a marker, pass the key on anywhere else. The marker is the session's id, a UUID. tmux's `-F` test takes a value starting with `0` for false (checked on tmux 3.4, 3.6 and 3.8: `0c19d8e2-…`, `00` and `0x` are all false). One session in sixteen gets such an id. In that session `Ctrl+q` and `Ctrl+w` never detached: the key went to claude, every time, for the session's whole life. That is the intermittent "in sessions serenity had started" report in 0051 that its checks could not reproduce; the checks there happened to use ids that did not start with `0`.

It surfaced as a flaky E2E test. A tmux server trace of a failure shows the key found in the root table with the agent pane current, `#{@serenity_session}` expanded to `0c19d8e2-d78b-4d21-8367-1a092d2c6a20`, and `send-keys C-q`, the else branch, run.

The same failures showed the binding check of 0051 switching itself off. tmux 3.4 (Ubuntu 24.04's) keeps no `C-Q` apart from `C-q`: binding `C-Q` replaces `C-q`, so `list-keys` shows one `C-q` line ending `send-keys C-Q`. The check never found a `C-Q` line, logged "cannot confirm the bindings" at the daemon's first check and stopped for the daemon's lifetime. A removed binding was then never put back.

## Decision

- **The condition is `#{!=:#{@serenity_session},}`**: the marker compared with the empty string, true for every set id, false where none is set. Ids stay UUIDs.
- **The binding check counts a binding with the old condition as changed**, so a tmux server that outlived the upgrade gets the new bindings at the daemon's next check, and `daemon.log` says so.
- **The check reads tmux 3.4's folded table.** A `C-q` line ending `send-keys C-Q` stands for both keys there. Where tmux keeps them apart (3.6 on), each key still needs its own line, so a lost `C-Q` is still found.
- **The check no longer gives up.** A rebind that `list-keys` still does not show is logged once, and the next check binds again. It logs again only after a confirmed check.

## Consequences

- `Ctrl+q` and `Ctrl+w` work in every session, whatever its id.
- If a future tmux prints the bindings in a form the check does not read, the daemon rebinds them every 5 s (four `bind-key` calls and a `list-keys`), logging once, instead of leaving them unchecked.
- Any other `-F` test serenity adds against a value that can start with `0` must compare it, not test it as is. `@serenity_map` is `1`, so its Shift+Enter test is unchanged.
- An E2E test reads the live `Ctrl+q` binding and evaluates its condition against a pane marked with an id starting with `0`.
