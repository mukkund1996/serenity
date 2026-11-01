# The docs page's "The map" GIF: vhs scripts/demo/docs/map.tape
Output website/docs/media/map.gif
Source scripts/demo/docs/settings.tape

Hide
Type "bun scripts/demo/demo.ts start && bun scripts/demo/demo.ts attach"
Enter
Wait+Screen@120s /zoom: topics/
# Start on the map zoom, on the master.
Type "z"
Wait+Screen /zoom: map/
Sleep 500ms
Show

Sleep 1.5s
# Move between topics: right to checkout, down to search, left to orders db.
Right
Sleep 1.2s
Down
Sleep 1.2s
Type "]"
Sleep 1.2s
Type "]"
Sleep 1.2s
# Zoom in to the topics: every session as a card.
Type "Z"
Sleep 1.8s
Down
Sleep 1.2s
Down
Sleep 1.2s
# Esc goes back up to the map.
Escape
Sleep 2s

Source scripts/demo/docs/stop.tape
