# 0066 · A welcome panel: logins, then importing past sessions, in one line each

**Status:** Accepted · 2026-11-06 · Amends [0065](0065-setup-logins.md) (the Setup panel becomes the welcome panel), [0064](0064-import-past-sessions.md) (the first-boot import hint) and [0062](0062-first-boot-tutorial.md)

## Context
The first boot from 0062 and 0065 had grown in pieces. The Setup panel showed three "enables" bullets and a "without it" line for each login. Past Claude Code sessions were only mentioned in a 15-second notice ("N Claude Code sessions … · I imports them"), which appeared under the Setup panel while the user was busy with it. Nothing told the user they were done. Each piece explained more than a new user needs at that moment, and the key hints differed from step to step ("Enter connect", "Esc done").

## Decision
- **One panel, "Welcome to serenity".** The order is: the first-run doctor (in the shell, unchanged), then GitHub, Slack and Import in the panel, then "You're set", then the tutorial card. The intro says how many steps there are and points to getserenity.dev/docs for more: "Three optional steps. More: getserenity.dev/docs".
- **One line per step.** Each step has a title, a status, and one line saying what it gives (`SetupStep.gives` replaces `enables` and `without`). Slack adds one privacy line while it's selected: "Nothing is sent until you press y · o PRIVACY.md". The login popups print the same lines.
- **The same keys everywhere.** The footer shows the selected step's keys, separated by `·`: `Enter log in · s skip · ↑↓ move`, `Enter import all · p pick · s skip · ↑↓ move`, or `Enter next` once a step is done. `Esc close` is on the border. Statuses use one vocabulary: `○ not logged in`, `○ not connected`, `✓ connected as …`, `✓ imported N`, `– skipped`.
- **An import step.** When the panel opens, it runs the dry run that `I` uses (`history.discover` for this repo, last 14 days). If there are no sessions, the step isn't shown and the intro counts two steps. Otherwise it shows the count and the 3 newest (title or first prompt, branch, last active), then "+N more". `Enter` imports them all through `history.import`. `p` opens the `I` picker (`ImportDialog`) on the same list. `s` skips. Imported sessions arrive ended, as in 0064, so nothing runs until Enter resumes one. The step stays out of `SETUP_STEPS`, because it isn't a login: `serenity doctor` and the settings panel don't list it.
- **"You're set".** Enter or `s` moves to the next step still to do. When none is left, the panel says "✓ You're set. Enter opens the tour.", and Enter closes it onto the `learn-serenity` card (0065). A panel opened when everything is already done starts at that line.
- **No duplicate hint.** The empty-map import notice is skipped while the welcome panel is pending. On later maps it reads "N past Claude sessions here · I imports them". The empty map says "n starts a session · I imports your past Claude sessions".
- **Shorter problem texts.** "gh not installed · brew install gh". Slack's "needs a login" becomes "not logged in", as GitHub's does. The doctor's gh line reads "not found · optional, for PRs (brew install gh)".

## Consequences
- A new user with history in the repo can bring it onto the map in one keypress during first boot, without learning about `I` first.
- Opening the panel reads Claude's history once more, which costs the same as `I` and is cached per file (0064).
- Fuller explanations live in the docs (getserenity.dev/docs#setup), not in the panel.
- The e2e setup test writes two transcripts, checks the step's preview, imports them and expects "You're set". `scripts/demo/demo.ts fresh` writes four transcripts for the onboarding GIF.
