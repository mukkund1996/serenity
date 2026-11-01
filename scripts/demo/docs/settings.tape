# Shared by the docs GIFs (Source'd by each tape here). See scripts/demo/README.md.
# 104 x 30 cells: narrow enough to read in the docs' 760 px column, wide
# enough for the map with topics on both sides of the master.
Require tmux
Require bun

Set Shell "bash"
Set FontSize 14
Set Width 1000
Set Height 530
Set Padding 14
Set Framerate 12
Set TypingSpeed 45ms
Set CursorBlink false
# getserenity.dev's palette, as in demo.tape.
Set Theme { "name": "serenity", "background": "#0d0f12", "foreground": "#d0d4da", "cursor": "#d0d4da", "selection": "#3a3f47", "black": "#0f1216", "red": "#d9534f", "green": "#7fc77f", "yellow": "#f2c14e", "blue": "#569cd6", "magenta": "#c792ea", "cyan": "#9cdcfe", "white": "#d0d4da", "brightBlack": "#6e7681", "brightRed": "#e06c69", "brightGreen": "#9fd89f", "brightYellow": "#f5d27a", "brightBlue": "#7fb4e6", "brightMagenta": "#d7aef0", "brightCyan": "#b8e6ff", "brightWhite": "#ffffff" }
