# The docs page's "NEEDS YOU" GIF: vhs scripts/demo/docs/needs-you.tape
Output website/docs/media/needs-you.gif
Source scripts/demo/docs/settings.tape

# A permission prompt, a question and a Slack mention arrive off camera.
Hide
Type "bun scripts/demo/demo.ts start && bun scripts/demo/demo.ts play needs-you && bun scripts/demo/demo.ts attach"
Enter
Wait+Screen@120s /NEEDS YOU 3/
Sleep 1s
Show

Sleep 2s
# Tab to the first item; its ◆ line says what y does.
Tab
Sleep 2s
Type "y"
Sleep 2.2s
# y again: tell price-filter "cents".
Type "y"
Sleep 2.2s
# Tab to the Slack mention; Enter marks it seen, x dismisses it.
Tab
Sleep 1.8s
Enter
Sleep 1.2s
Type "x"
Sleep 2.5s

Source scripts/demo/docs/stop.tape
