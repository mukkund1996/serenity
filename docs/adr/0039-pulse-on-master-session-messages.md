# 0039 · A card pulses when the master messages it, the master when the session answers

**Status:** Accepted · 2026-10-29 · Amended by [0042](0042-master-shows-three-eased-pulse-text-fields-edit.md): one swell in and out over 1.4 s, colour only, instead of three blinks

## Context
`send_reply` (0035, 0036) types into a session at once, so the master now talks to sessions without a `y`. Nothing on the map showed it: the user saw the chat say "Sent to api-auth." and, later, the card's text change. Which session the master just messaged, and when it answered, was easy to miss. 0012 allowed one animation, the master's spinner, and asked that it stay cheap.

## Decision
- **A pulse, not a new element.** When the chat's `send_reply` types into a session, that session's card frame (topics zoom), or its row's name and its topic's bubble frame (map zoom), blinks heavy bright magenta three times over 1.2 s. When the session answers, the master's frame does the same. Magenta is the master's colour, so the blink reads as "message from / to the master". Nothing moves and no layout changes; a reply waiting for `y` in NEEDS YOU pulses nothing.
- **The answer is the session's next turn end** after the send. A send to a working session may be read in that turn or queued for the next: if a new turn starts within 2 s of the end, that turn's end is the answer instead. A session that ends or is archived first never answers.
- **The daemon says when, the TUI animates.** `RepoState.pings` lists the last 5 s of messages (`sessionId`, `to: "session" | "master"`, `at`), kept in memory by the master supervisor and broadcast with the state. The TUI lights a node while `now - at` is in an even 200 ms phase of the 1.2 s pulse.
- **Cheap.** The TUI ticks a clock once a phase only while a pulse runs, and stops when the latest ends: six re-renders per ping, none when idle. The spinner stays as it was.

## Consequences
- 0012's "the spinner is the one animation" now reads: the spinner and the pulse.
- Pings are not stored; a map opened after a send shows no pulse for it, and a daemon restart forgets a send still awaiting its answer.
- Daemon and TUI share the clock of one machine, so `at` is compared with the TUI's own time.
