# The docs page's "First boot" GIF: vhs scripts/demo/docs/onboarding.tape
# A fresh serenity home in a fresh repo: the first-run checks, then the map
# with the learn-serenity tutorial, which teaches its first step.
Output website/docs/media/onboarding.gif
Source scripts/demo/docs/settings.tape

Hide
Type "source $(bun scripts/demo/demo.ts fresh) && clear"
Enter
Sleep 2s
Show

Sleep 600ms
Type "serenity"
Sleep 400ms
Enter
# The first-run checks print, then the map opens with the tutorial's node.
Wait+Screen@60s /learn-serenity/
Sleep 3s
# The master has the focus; → moves to the tutorial's card, Enter attaches it.
Right
Sleep 1.2s
Enter
Wait+Screen@30s /Reply "ready"/
Sleep 3s
Type "ready"
Sleep 300ms
Enter
Wait+Screen@30s /getserenity.dev\/docs\/#map/
Sleep 3.5s
# Ctrl+q: back to the map, as the tutorial says.
Ctrl+Q
Sleep 2.5s

Source scripts/demo/docs/stop.tape
