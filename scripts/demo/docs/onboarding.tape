# The docs page's "First boot" GIF (and the README's): vhs scripts/demo/docs/onboarding.tape
# A fresh serenity home in a fresh repo: the welcome panel imports the repo's
# past Claude sessions, logs in to GitHub (the fake gh's device flow) and
# Slack (the fake claude's mcp login) in popups, then hands over to the
# learn-serenity tutorial (ADR 0062, 0065, 0066).
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
# The map opens with the welcome panel on Import: 4 past sessions, the latest listed.
Wait+Screen@60s /Enter import all/
Sleep 3s
# Enter imports them all, parked; GitHub is next.
Enter
Wait+Screen@30s /› GitHub/
Sleep 2s
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
Wait+Screen@30s /You're set/
Sleep 2.5s
# Enter: onto the tutorial's card; Enter opens it.
Enter
Sleep 1.5s
Enter
Wait+Screen@30s /Reply "ready"/
Sleep 3s

Source scripts/demo/docs/stop.tape
