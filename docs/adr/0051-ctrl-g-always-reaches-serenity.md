# 0051 · Ctrl+g in an agent pane always reaches serenity, never claude

**Status:** Accepted · 2026-10-30 · Amends [0004](0004-sessions-in-tmux-panes.md) (the Ctrl+g binding) and [0026](0026-arrows-between-nodes-enter-into-ctrl-m-master.md) (the Ctrl+m binding)

## Context
Ctrl+g is bound in tmux's root table. In a pane carrying `@serenity_session` it runs `serenity detach`; anywhere else it passes the key on. Claude Code binds Ctrl+g to "edit the prompt in `$EDITOR`", so a Ctrl+g that passes through in an agent pane opens vim instead of going back to the map. That happens whenever, at the moment of the key, the pane lacks its marker or the root table lacks serenity's binding. PR #47 fixed one cause: an imported session followed by `/clear` lost its marker. The bug was still reported in 0.7.0, intermittently, in sessions serenity had started, shortly after attaching.

What was checked against a real tmux 3.8 and a real Claude Code (2.1.314), with Ctrl+g typed through a real tmux client:
- The marker survives `respawn-pane -k` (claude restarted in place, 0044), `join-pane` and `break-pane` (attach and park). Pane ids do not change.
- A daemon restart (0045) keeps both, because they live in the tmux server.
- Nothing in serenity removes the marker from a pane it started; the only `unset` calls are for imported panes whose claude exited or which were archived.
- Plain Ctrl+g, xterm `modifyOtherKeys` (`ESC[27;5;103~`, which tmux asks the terminal for once `extkeys` is on), CSI u (`ESC[103;5u`) and kitty forms that report Caps Lock or Num Lock all match the `C-g` binding. Typed straight after an attach, Ctrl+g detached 15 times out of 15.
- The binding has had the same `if-shell -F "#{@serenity_session}"` form since the first release; no version ever unbound it.
- Claude does not switch iTerm2's keyboard mode through tmux passthrough, so the kitty forms tmux cannot parse (`ESC[103;5:1u` with event types, `ESC[103:71;5u` with alternate keys) do not arise.

Two holes were found:
- **Ctrl+g with Caps Lock.** A terminal that sends extended keys may report it as Ctrl+G (`ESC[27;5;71~`). tmux keeps `C-G` apart from `C-g`, so the binding missed, the key went to claude, and claude opened vim. Ctrl+m with Caps Lock (`C-M`) missed its binding the same way. iTerm2 sends the lowercase key, so this was not the reported case.
- **Nothing puts the marker or the binding back.** Both live in the tmux server, where anything can change them: another program or agent running `tmux` against the user's server (agents in serenity panes have `$TMUX` set), a config reload with `unbind-key -a`, a plugin that binds Ctrl+g. Serenity set them once, at spawn and at attach, and never looked again. Nothing recorded such a change either, so the cause stayed invisible.

## Decision
- **Both cases of each key are bound.** `C-g` and `C-G` run `serenity detach` in an agent pane; `C-m` and `C-M` run `detach … master`. Outside an agent pane each passes the key on unchanged. `S-Enter` is as before.
- **The daemon checks every 5 s, and at start, that every live session's pane still carries its marker and that the root table still holds serenity's bindings.** Missing ones are set again, and each repair is logged to `daemon.log` (`<name>: pane %N had lost its @serenity_session marker; set it again`, `the Ctrl+g / Ctrl+m bindings were missing or changed; bound them again`). The check costs two tmux calls (`list-panes -a`, `list-keys -T root`) and runs only while a session is live or a map is open.
  - **Only a pane that still runs that session's claude is marked again.** Pane ids start at `%0` again after a tmux server restart, so a stale id may now name a stranger's pane. A pane counts as the session's if its start command is serenity's agent wrapper (`serenity-agent`, hook-tracked sessions) or Claude's own session file puts the session's claude pid in it (imported sessions).
  - **Ending comes before unmarking.** An imported session whose claude exited is marked ended before its pane's marker is removed, and an archived one is archived first, as before. The check therefore does not mark a pane that is being let go.
  - **The binding check gives up rather than loop.** If `list-keys` still does not show the bindings right after rebinding them (tmux printing them in a form the check does not expect), the check logs that once and stops checking the bindings. Markers are still checked.
  - `SERENITY_TMUX_CHECK_MS` sets the interval (the E2E tests use 300 ms).
- **Ctrl+g finds the session in that pane by preferring a live one.** `session.detach` by pane id used to take the first stored session with that id, which after a tmux server restart could be an ended session whose old pane had the same id; Ctrl+g then did nothing. A live session now wins over ended ones, and a more recent one over an older one.
- **E2E tests type keys through a real tmux client.** `send-keys` bypasses key bindings, so the earlier tests ran the detach command directly and never exercised the binding. A second tmux server now runs a client of the test server in a pane, and keys are typed as raw bytes into it. The fake claude prints `opened $EDITOR` when it receives Ctrl+g, as Claude Code opens the editor. The tests cover plain Ctrl+g and the Caps Lock form, and a marker and binding removed behind serenity's back being restored.

## Consequences
- An agent pane whose marker or binding was removed can still pass a Ctrl+g to claude for up to 5 s. When that happens, `daemon.log` says what was repaired and when, which is the evidence still missing for the reported case.
- Two serenity installs with different homes on one tmux server would rebind over each other every 5 s, logging each time. The dev setup (`bun run dev`) and the E2E tests use their own tmux sockets, so they do not.
- A pane the user splits off inside a serenity window has no marker and still passes Ctrl+g on, as it should for a shell.
