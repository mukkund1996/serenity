# 0006 · Session status from Claude Code hooks only

**Status:** Accepted · 2026-10-25 · revisit the event-capture design after v1

## Context
Each card needs a status: waiting, working, idle, finished, dead, archived. Options were hooks, hooks + `tmux capture-pane`, or tailing transcript files.

## Decision
- **Hooks only for now.** serenity spawns each session as `claude --settings <serenity-hooks.json>`; the user's own settings are never modified.
- Each hook runs `serenity hook <event>`, which reads the hook's JSON from stdin and forwards it to the daemon over the socket. The session is identified by `SERENITY_SESSION_ID`, set in the pane's environment at spawn.
- Hook events of interest: `SessionStart`, `UserPromptSubmit` → working; `Notification` → waiting; `Stop` → idle or finished (decided by the Haiku worker, 0007); `SessionEnd` → dead unless archived.
- The hook payload's `transcript_path` is stored on the session so the master can read it.
- `serenity hook` must be fast and never block Claude Code: short timeout, fire-and-forget, exit 0 even when the daemon is down.

## Consequences
- A crashed `claude` or killed pane fires no `SessionEnd`. **Open:** whether a tmux pane-exit check (not capture-pane) counts as in scope for v1 to detect `dead`.
- The richer capture system (capture-pane, transcript tailing) is deliberately deferred and will get its own ADR.
