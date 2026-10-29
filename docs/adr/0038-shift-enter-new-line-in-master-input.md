# 0038 · Shift+Enter starts a new line in the master input

**Status:** Accepted · 2026-10-29

## Context
The master input grows to four lines (0036), but every line break sent it: a brief with a list, or a message about two sessions, had to be one run-on line. Enter has to keep sending. A terminal sends Shift+Enter as the same byte as Enter, CR, unless it sends extended keys, and then tmux passes them on only to programs that ask for them. Ink reads CSI u keys (`ESC [13;2u` is Shift+Enter) but not xterm's `ESC [27;2;13~`, and asking tmux for extended keys in the map pane would change how every modified key reaches it.

## Decision
- **Shift+Enter starts a new line; Enter sends.** Backspace removes a line break like any character. Each line starts a row of the input; the four-row limit and the `…` for a longer message are unchanged.
- **How Shift+Enter gets through.** The same way as `Ctrl+m` (0026): serenity binds `S-Enter` in tmux's root table. In the map pane (`@serenity_map`) it sends `ESC [13;2u`; anywhere else it sends `S-Enter` on, so Claude Code panes still get their own Shift+Enter.
- **Extended keys are on before the map's client attaches.** tmux reads a client's terminal features when it attaches, so `serenity` turns on `extended-keys` and the `extkeys` feature (`enableClaudeKeys`) just before `attach-session`, not only when a session is first attached. This was #7.
- **Fallbacks that need no extended keys:** Alt+Enter (`ESC CR`) and Ctrl+J (a bare line feed) also start a new line.

## Consequences
- In a terminal without extended keys (Apple Terminal) Shift+Enter is Enter and sends; Ctrl+J works everywhere, and Alt+Enter where Option sends Meta.
- A Ctrl+J used to send like Enter; it no longer does. A pasted chunk still sends at its first line break, as before.
- Like `C-m`, the `S-Enter` binding lives in the tmux server and also covers the user's own panes, where it only passes the key through.
- Only the master input takes new lines; the other text fields (a card's reply, search, rename) still send or close on any Enter.
