# 0057 · `x` on any NEEDS YOU item only dismisses it; a card's `x` still cleans up

**Status:** Accepted · 2026-11-03 · Amends 0034, 0040, 0050

## Context
`x` meant two things. On a Slack item it dismissed the item (0034), and on a queued reply it dropped the reply (0040). On every other NEEDS YOU item the key fell through to the focused-session handler. For a session (waiting on a prompt or a question, watched and finished, ended, or carrying a ◆ suggestion) that opened the cleanup confirm, which offers to stop it and remove its worktree. On the master's own permission request it did nothing. A key that hides one list item should not start the most destructive action serenity has.

## Decision
- **On the master, `x` only dismisses the selected item.** It is handled before any session key, so it never reaches the cleanup, kill, archive or answer paths. With nothing selected it does nothing. What it does per item:

  | Item | `x` |
  |---|---|
  | Slack mention or DM | Dismissed by message, for good (0034). A newer message shows again. |
  | Queued reply (QUEUE) | Declined (0040), as `n` does. |
  | The master's permission request | Hidden from NEEDS YOU and left pending: neither allowed nor denied. It still times out after 10 minutes, as any unanswered request does. A new request shows. |
  | Session waiting on a permission prompt, a question or the startup prompt | Hidden. The prompt stays unanswered in its pane. It shows again when the session asks something new (its `ask` or `waitingOn` changes), when its status changes, or when a newer suggestion comes. |
  | Session watched and finished, or ended | Hidden, and nothing else happens: it is not archived and keeps its watch. It shows again when its status changes or a newer suggestion comes. |
  | Session with a pending ◆ suggestion (approve, cleanup, review, reply) | The suggestion is declined and the session hidden. A newer suggestion brings it back. An approve suggestion declined this way does not answer the prompt it was about. |

- **`session.dismiss` takes a mode.** `seen` is Enter (0050) and stays the default. It refuses a waiting session and drops a finished session's watch. `dismiss` is `x`: it allows a waiting session, keeps the watch, and declines the session's pending suggestions. A queued reply has its own section, so `dismiss` leaves it alone. Both modes set `dismissedAt` in the session row, so a dismissal lasts across restarts of the TUI and the daemon, like Slack's `slack_dismissals`.
- **A waiting session's dismissal ends on a new prompt.** The daemon already cleared `dismissedAt` when the status changed. It now also clears it when a waiting session's `ask` or `waitingOn` changes. `needsYou` no longer shows a dismissed session just because it waits.
- **`master.dismissPermission { id }`** marks the pending request dismissed, and `state.permissions` leaves it out. The chat's hang check still counts it, so a chat waiting on a hidden request is not taken for hung. A pending request lives only in the daemon's memory and is denied when the daemon stops, so keeping the flag there loses nothing.
- **A card's `x` keeps its meaning.** On a session card (topics or map zoom) `x` still opens the cleanup confirm. A NEEDS YOU item is selected inside the master, and a card is a node outside it. `xAction` in the TUI decides from that alone, so the two cannot mix.
- **Hints.** NEEDS YOU and queue items show `x` beside `y e n` (`y n x` on a permission request). The map's master box reads `y allow · n deny · x dismiss` on a permission request. The shortcuts panel, README and website say `x` dismisses on a NEEDS YOU item and cleans up on a card.

## Consequences
- 0050 said a session waiting on the user is never hidden, because hiding a blocked agent would stall it. That still holds for Enter. `x` is an explicit choice, and the session's card still shows it waiting on the map.
- A dismissed master permission request has nowhere to be answered, so unless the chat asks again it is denied when it times out. That is the same outcome as leaving it unanswered.
- A waiting session whose `ask` is rewritten with the same meaning (a new summary of the same prompt) shows again early. It reappears rather than staying hidden, which is the safer way to be wrong.
