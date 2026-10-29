# 0044 · Claude restarts in its pane when it exits

**Status:** Accepted · 2026-10-29 · Amends [0006](0006-status-from-hooks.md) (SessionEnd) and [0022](0022-pinned-sessions.md) (ended sessions)

## Context
A session's claude ends for many reasons: `/exit`, Ctrl+C twice, Ctrl+D, a crash, an out-of-memory kill. Each one left the session dead on the map, and getting it back meant a new session or, for a pinned one, attaching to resume it. Most of these exits are not a decision to stop working. The user ends a task through serenity, by archiving it (`K`, cleanup, the master's `archive_session`).

Claude cannot report its own exit reliably. `/exit`, Ctrl+C and Ctrl+D all exit with code 0 and the same `SessionEnd` reason, and a crash sends no hook at all. The agent's wrapper shell (`serenity exited <code>`) does see every exit.

## Decision
- **Any exit serenity did not cause restarts claude.** Archiving sets the session archived before its pane is killed, so the exit report that follows is ignored. Every other exit, clean or not, restarts claude after a backoff. Quitting claude therefore no longer ends a session; archiving does.
- **In the same pane, continuing the conversation.** Agent panes have `remain-on-exit` set, so the pane outlives claude and `respawn-pane` reuses it: same pane id and window, and an attached session stays attached. The restart runs `claude --resume <claude session id>`, or `--continue` if none was recorded. A pane that is gone anyway (one started before this change) gets a new window.
- **Backoff and a crash-loop limit.** Restarts wait 1, 2, 4, 8 and 16 s. A sixth exit within 10 minutes of the first of those restarts leaves the session dead, its pane closed, and the card reads `Session ended: claude exited 6 times in 10 min (last with code 1).` The count lives in the daemon, so a daemon restart forgets it.
- **A claude that never started stays ended.** If claude exits before its first `SessionStart` (a refused folder trust prompt, a broken install), restarting would only repeat the failure, so the session ends: `claude exited before it started (code 0)`.
- **The map shows what happened.** `Session` gains `exitNote`. After a restart the card leads with `Claude exited (code 3); restarted.` until the next prompt clears it; on an ended session it is the reason, also shown in NEEDS YOU.
- **`SessionEnd` no longer marks a session dead.** It clears the ask and subagents; the exit report decides between restarting and dead. A restart therefore does not flash the session dead, end a watch or drop its suggestions.

## Consequences
- `/exit` cannot end a session by itself. To stop one, archive it; to stop one briefly, there is no switch yet.
- `SERENITY_RESPAWN_BASE_MS` sets the first delay (the E2E tests use 100 ms).
- Imported sessions not yet restarted under serenity's hooks (0016) have no wrapper, so they still end when their claude exits.
- A pinned session that ended (from the crash-loop limit or before this change) still resumes on attach (0022), with a fresh count.
