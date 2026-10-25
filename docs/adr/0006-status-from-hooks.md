# 0006 · Session status from Claude Code hooks, plus an exit report

**Status:** Accepted · 2026-10-25 · revised 2026-10-25 (exit report, startup prompt) · revisit the event-capture design after v1

## Context
Each card needs a status: waiting, working, idle, finished, dead, archived. Options were hooks, hooks + `tmux capture-pane`, or tailing transcript files.

Testing milestone 1 showed two cases hooks cannot cover:
- **Claude fires no hooks until its folder trust prompt is answered**, and every new worktree is an untrusted folder. A new session waiting on that prompt looked idle.
- **Claude can exit without `SessionEnd`**: refusing trust (`Esc` or the default "No, exit" — hooks never loaded), a crash, a killed process. The card stayed live, and actions failed with "no live pane".

## Decision
- **Hooks for status.** serenity spawns each session with `claude --settings <serenity-hooks.json>`; the user's own settings are never modified.
- Each hook runs `serenity hook <event>`, which reads the hook's JSON from stdin and forwards it to the daemon over the socket. The session is identified by `SERENITY_SESSION_ID`, set in the pane's environment at spawn.
- Hook events: `SessionStart` → idle; `UserPromptSubmit`, `PostToolUse` → working; `PermissionRequest`, blocking `Notification`s → waiting; `Stop` → idle or finished (decided by the Haiku worker, 0007); `SessionEnd` → dead unless archived.
- **Exit report.** The agent pane runs `sh -c 'claude …; serenity exited $?'`. The `sh` parent reports every exit, with its code, as `session.exited` → dead. It is scoped to our sessions only. A tmux `pane-exited` hook was tried and rejected: set on one session, it fired for pane exits in other sessions too.
- **Startup prompt.** If a new session sends no `SessionStart` within 5 s, it is shown as waiting with "confirm Claude's startup prompt (folder trust)", so it appears in NEEDS YOU. `SessionStart` clears it.
- **Fallback.** If an attach or reply finds the pane gone, the session is marked dead instead of failing repeatedly.
- The hook payload's `transcript_path` is stored on the session so the master can read it.
- `serenity hook` and `serenity exited` must be fast and never block Claude Code: short timeout, fire-and-forget, exit 0 even when the daemon is down.

## Consequences
- A killed tmux server or `kill-pane` also kills the `sh` parent, so no exit report is sent; the fallback catches it on the next action.
- The 5 s grace period is a guess at Claude's startup time; `SERENITY_STARTUP_GRACE_MS` overrides it.
- The richer capture system (capture-pane, transcript tailing) is deliberately deferred and will get its own ADR.
