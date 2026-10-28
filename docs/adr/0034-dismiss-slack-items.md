# 0034 · `x` dismisses a Slack item from NEEDS YOU, for good, by message

**Status:** Accepted · 2026-10-28 · Amends 0031

## Context
ADR 0031 keeps a Slack mention or DM in NEEDS YOU until the inbox worker no longer finds that it needs an action. The triage is the model's judgement, so an item the user has dealt with elsewhere (in person, in another thread) or does not mean to act on can stay for days, taking one of the three places. There was no way to say "not this one".

## Decision
- **`x` on a selected Slack item dismisses it.** On a session `x` cleans up; a Slack item is not a session, so the key does not clash, and both mean "done with this". The shortcuts panel lists it beside `y e n`.
- **Through the daemon.** `slack.dismiss { channelId, ts }` records the dismissal and drops the item at once from every map, its ◆ suggestion with it. Slack is read per account (0023), so a dismissal is per account too, not per repo.
- **Keyed by the message, kept for good.** A dismissal is the waiting message's channel and ts, stored in SQLite (`slack_dismissals`), so it survives restarts of the TUI and the daemon. A newer message in the same thread or DM has another ts and shows as a new item.
- **The worker skips them.** The inbox prompt lists the dismissed messages from its 7-day window so the worker leaves them out and fills the three places with others; the daemon filters its answer too, in case it does not.
- **The master does not see them.** Its snapshot reads the same filtered inbox.
- No undo. Opening the message in Slack (`o`) before dismissing still works; a dismissed one can be found in Slack or through the chat.

## Consequences
- Dismissals accumulate; they are a few bytes each, and only the last week's are sent to the worker.
- The worker may still return a dismissed message; it is then dropped, and NEEDS YOU shows one Slack item fewer until the next read.
