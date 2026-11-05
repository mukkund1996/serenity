# The docs page's "First boot" GIF (and the README's): vhs scripts/demo/docs/onboarding.tape
# A fresh serenity home in a fresh repo: the Setup panel logs in to GitHub
# (the fake gh's device flow) and Slack (the fake claude's mcp login) in
# popups, then hands over to the learn-serenity tutorial (ADR 0062, 0065).
Output website/docs/media/onboarding.gif
Source scripts/demo/docs/settings.tape

Hide
Type "source $(bun scripts/demo/demo.ts fresh) && clear"
Enter
Sleep 2s
Show

Sleep 500ms
Type "serenity"
Sleep 300ms
Enter
# The map opens with the Setup panel: GitHub logged out, Slack not connected.
Wait+Screen@60s /not connected · off for this repo/
Sleep 2.5s
# Enter: gh's device flow in a popup; Enter again "opens the browser".
Enter
Wait+Screen@30s /one-time code/
Sleep 1.5s
Enter
Wait+Screen@30s /› Slack/
Sleep 2s
# Enter: Slack's login through Claude Code, which also turns it on here.
Enter
Wait+Screen@30s /Your token stays with Claude Code/
Wait+Screen@30s /Sam \(Acme\) · on for this repo/
Sleep 2.5s
# Enter: done, onto the tutorial's card; Enter opens it.
Enter
Sleep 1.5s
Enter
Wait+Screen@30s /Reply "ready"/
Sleep 3s

Source scripts/demo/docs/stop.tape
