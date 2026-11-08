# The Reddit launch clip's raw recording: vhs scripts/demo/reddit/reddit.tape
# The README's map (about 190 columns, master centred) rendered large, so
# frame.py can zoom the camera in on the master or a card and stay sharp.
# See scripts/demo/reddit/README.md.

Output scripts/demo/reddit/out/raw.mp4

Require tmux
Require bun

Set Shell "bash"
Set FontSize 24
Set Width 2950
Set Height 1610
Set Padding 30
Set Framerate 24
Set TypingSpeed 45ms
Set CursorBlink false
# getserenity.dev's palette, as in demo.tape.
Set Theme { "name": "serenity", "background": "#0d0f12", "foreground": "#d0d4da", "cursor": "#d0d4da", "selection": "#3a3f47", "black": "#0f1216", "red": "#d9534f", "green": "#7fc77f", "yellow": "#f2c14e", "blue": "#569cd6", "magenta": "#c792ea", "cyan": "#9cdcfe", "white": "#d0d4da", "brightBlack": "#6e7681", "brightRed": "#e06c69", "brightGreen": "#9fd89f", "brightYellow": "#f5d27a", "brightBlue": "#7fb4e6", "brightMagenta": "#d7aef0", "brightCyan": "#b8e6ff", "brightWhite": "#ffffff" }

# The made-up world off camera; the reddit timeline (scenario.ts) brings in
# three Slack messages over 3 s, the last asking for a fix.
Hide
Type "unset TMUX TMUX_PANE; bun scripts/demo/demo.ts start && (bun scripts/demo/demo.ts play reddit >/dev/null 2>&1 &) && bun scripts/demo/demo.ts attach"
Enter
Wait+Screen@120s /zoom: topics/
Show

# 1. NEEDS YOU fills.
Wait+Screen@20s /NEEDS YOU 3/
Sleep 2.5s

# 2. Tab to the first item: Priya's request, "Start new session fix-csv-export".
Tab
Sleep 2.5s

# 3. The camera moves to the orders db topic first (frame.py), then y
# starts the session there; 4. it files itself under orders db and works.
Sleep 1.8s
Type "y"
Wait+Screen@20s /Found it: an off-by-one/
Sleep 3.5s

# 5. @new from the master's input, once frame.py's camera is back on the master.
Sleep 2.5s
Type "i"
Sleep 600ms
Type@70ms "@new create a fix for the dto validation of purchase endpoint"
Sleep 500ms
Enter
Wait+Screen@20s /Started purchase-dto-fix/
Sleep 3s

# 6. @ a session: report back on Slack.
Type@70ms "@fix-csv-export message Priya on Slack when you're done"
Sleep 500ms
Enter
Wait+Screen@20s /Told fix-csv-export/
Sleep 3.5s

# 7. x dismisses the three Slack items while frame.py's camera pulls out
# to the whole map: NEEDS YOU empties and the map is calm.
Escape
Sleep 300ms
Tab
Type "x"
Sleep 500ms
Tab
Type "x"
Sleep 500ms
Tab
Type "x"
Wait+Screen@20s /nothing needs you/
Escape
Sleep 5s

Hide
Ctrl+B
Type "d"
Type "bun scripts/demo/demo.ts stop"
Enter
Sleep 3s
