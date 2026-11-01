# The README demo GIF. Re-record from the repo root with:
#   vhs scripts/demo/demo.tape
# Needs vhs (brew install vhs), tmux and bun. See scripts/demo/README.md.

Output docs/demo.gif

Require tmux
Require bun

Set Shell "bash"
# About 190 columns: from roughly 180 serenity centres the master with topics
# on both sides (ADR 0027); narrower, the master docks left.
Set FontSize 14
Set Width 1720
Set Height 940
Set Padding 18
Set Framerate 15
Set TypingSpeed 0
Set CursorBlink false
# getserenity.dev's palette.
Set Theme { "name": "serenity", "background": "#0d0f12", "foreground": "#d0d4da", "cursor": "#d0d4da", "selection": "#3a3f47", "black": "#0f1216", "red": "#d9534f", "green": "#7fc77f", "yellow": "#f2c14e", "blue": "#569cd6", "magenta": "#c792ea", "cyan": "#9cdcfe", "white": "#d0d4da", "brightBlack": "#6e7681", "brightRed": "#e06c69", "brightGreen": "#9fd89f", "brightYellow": "#f5d27a", "brightBlue": "#7fb4e6", "brightMagenta": "#d7aef0", "brightCyan": "#b8e6ff", "brightWhite": "#ffffff" }

# Set up the made-up world off camera: six sessions at work, Slack quiet.
Hide
Type "bun scripts/demo/demo.ts start && (bun scripts/demo/demo.ts play >/dev/null 2>&1 &) && bun scripts/demo/demo.ts attach"
Enter
Wait+Screen@120s /zoom: topics/
Sleep 500ms
Show

# The timeline (scenario.ts) plays on its own: a permission prompt at 3 s,
# a Slack mention at 7 s, a question at 11 s, a Slack DM at 14 s.
Sleep 15.5s

# Tab to what needs you; y approves the migration.
Tab
Sleep 1.2s
Type "y"
Sleep 2s

# Tab to Sam's DM; y tells flaky-e2e, whose answer becomes the drafted reply.
Tab
Sleep 1.2s
Type "y"
Sleep 5.5s

Hide
Ctrl+B
Type "d"
Type "bun scripts/demo/demo.ts stop"
Enter
Sleep 3s
