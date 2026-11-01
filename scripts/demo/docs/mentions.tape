# The docs page's "@ mentions" GIF: vhs scripts/demo/docs/mentions.tape
Output website/docs/media/mentions.gif
Source scripts/demo/docs/settings.tape

Hide
Type "bun scripts/demo/demo.ts start && bun scripts/demo/demo.ts attach"
Enter
Wait+Screen@120s /zoom: topics/
Type "i"
Sleep 500ms
Show

# @ lists the commands, then the sessions; typing narrows it.
Type "@"
Sleep 1.3s
Type "ca"
Sleep 800ms
Tab
Sleep 500ms
Type@30ms "does the badge update live yet?"
Sleep 300ms
Enter
Wait+Screen@20s /live updates land/
Sleep 1s
# @new starts a session from a brief.
Type@30ms "@new add a wishlist page"
Sleep 300ms
Enter
Wait+Screen@20s /Started wishlist/
Sleep 1s
# @copy hands a session's work on to a fresh one.
Type@30ms "@copy @checkout-retry add retry metrics next"
Sleep 2s

Source scripts/demo/docs/stop.tape
