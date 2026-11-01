# The docs page's "The master agent" GIF: vhs scripts/demo/docs/master.tape
Output website/docs/media/master.gif
Source scripts/demo/docs/settings.tape

Hide
Type "bun scripts/demo/demo.ts start && bun scripts/demo/demo.ts play master && bun scripts/demo/demo.ts attach"
Enter
Wait+Screen@120s /NEEDS YOU 2/
# Start away from the master, on a card.
Right
Sleep 1s
Show

Sleep 1s
# Ctrl+w focuses the master from anywhere; i opens its input.
Ctrl+W
Sleep 1s
Type "i"
Sleep 500ms
Type "what's waiting on me?"
Sleep 400ms
Enter
Wait+Screen@20s /approve it/
Sleep 6s

Source scripts/demo/docs/stop.tape
