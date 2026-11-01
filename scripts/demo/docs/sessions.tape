# The docs page's "Sessions" GIF: vhs scripts/demo/docs/sessions.tape
Output website/docs/media/sessions.gif
Source scripts/demo/docs/settings.tape

Hide
Type "bun scripts/demo/demo.ts start && bun scripts/demo/demo.ts attach"
Enter
Wait+Screen@120s /zoom: topics/
Sleep 500ms
Show

Sleep 1s
# / finds cart-badge's card; Enter goes into its Claude Code pane.
Type "/cart"
Sleep 800ms
Enter
Sleep 1s
Enter
Sleep 1.5s
Type "does the badge update live yet?"
Sleep 300ms
Enter
Sleep 4s
# Ctrl+q: back to the map, where the card has its answer.
Ctrl+Q
Sleep 3s

Source scripts/demo/docs/stop.tape
