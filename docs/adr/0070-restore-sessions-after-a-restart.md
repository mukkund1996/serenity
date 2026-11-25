# 0070 · Sessions lost with the tmux server come back with `claude --resume`

**Status:** Accepted · 2026-11-25 · Amends [0022](0022-pinned-sessions.md), [0044](0044-claude-restarts-in-its-pane.md), [0045](0045-daemon-supervisor-crash-reports-recovery.md)

## Context
serenity already survives its own restarts (0045, 0046), and a claude that exits restarts in its pane (0044). A machine restart or shutdown, or `tmux kill-server`, takes the tmux server and every agent pane with it. On the next start, the reconcile in `recover.ts` found the panes gone and marked every session ended. Only pinned sessions came back, one at a time when attached (0022). The user had to find and resume each session by hand, though the worktrees, branches and Claude transcripts were all still on disk (#131).

## Decision
- **serenity records which tmux server the panes are in**, as `#{pid}:#{start_time}` in the `recovery` table. The daemon compares the running server with that record on start, on every tmux check (0051, every 5 s), when a map opens and before it opens a pane. If no server is running, or a different one is, the panes were lost with the server.
- **A lost server interrupts sessions; a closed pane still ends them.** With the same server, a missing pane means the user closed it, and the session ends as before. With a lost server, each idle, working or waiting session is **interrupted**: it shows as ended, with `interrupted` holding what it was doing, and its pane id is dropped, since a new server reuses ids from %0. Done sessions end. Ended and archived ones are untouched. On a lost server, only a pane still marked `@serenity_session` with the session's id counts as its pane.
- **Interrupted sessions are restored when their repo's map opens.** After a reboot that is the first `serenity` run. If the server dies while a map is open outside tmux, it happens at once. Only that repo's sessions start, so other repos don't spend processes. Each one is resumed through the pinned-resume path (0022): a new window in the repo's tmux session, the session's folder, `claude --resume <claudeSessionId>`, serenity's hooks and the agent MCP config, and the check that the conversation is not open in another terminal. Topic, name, pin, PR, fan-out parent and map position are untouched, since only the pane changes.
- **Restores are automatic, not asked.** `--resume` with no prompt sends nothing to the model, so it uses no plan quota, and every one of these sessions was live when the machine went down. Restores run one at a time, 1.5 s apart (`SERENITY_RESTORE_STAGGER_MS`). The settings panel's *After a restart* row (`restoreSessions` in config.json, on by default) turns this off. Interrupted sessions then stay ended, and Enter resumes one, as for pinned sessions.
- **What can't come back says why and doesn't hold up the rest.** This covers a session with no Claude session id, a missing folder (the worktree was deleted), a missing transcript, or a resume refused because claude is open elsewhere. Each is left ended with "not restored after a restart: <why>". A resume that starts and then fails follows 0044's backoff and end rule.
- **A restored session comes back idle, with a note** until its next prompt. A permission prompt or a cut-off turn cannot be restored, so the note says so ("the permission prompt it waited on was lost, so ask it to go on").
- **The map shows a notice**: "restoring N sessions after a restart…", then "restored N sessions after a restart · not restored: docs (its folder … is gone)".
- **Restoring is idempotent.** A repo restores once at a time. Each step re-reads the session, and one already resumed (by Enter, say) is skipped. A pane already marked with the session's id, left by a restore cut short, is taken back instead of opening a second window.
- **Adopted sessions (0016) come back in serenity's own windows**, under its hooks, as pinned and imported ones do. Their old windows in the user's tmux died with the server too.
- The master needs nothing new. It runs outside tmux and resumes its conversation after a daemon restart (0046).

## Consequences
- After a reboot, `serenity` brings the map back as it was, with each live session in a pane in its worktree.
- Pinned sessions follow the same path. The attach-time resume of 0022 now also covers interrupted sessions.
- Killing serenity's agent windows one by one with tmux, and then the last window so the server exits, counts as a lost server. Ending a session in serenity (`x`, cleanup) archives it, so it never comes back.
- **The first start of this build has no server on record**, so two fallbacks apply then and only then:
  - A session last changed before the running server started had its pane in an earlier server, so it is interrupted.
  - A session an older build already ended after the machine booted (`sysctl kern.boottime`, or `btime` in `/proc/stat`), with no reason recorded, a conversation to resume and its folder still there, is restored once. This covers users who rebooted on an older build: a pull and `serenity restart` bring those sessions back. A pane the user closed after the boot on the old build comes back too, which is the cost of that catch-up.
- The e2e test `reboot-recovery` kills the test tmux server with the daemon both down and running, and checks the resumed panes, their folders, and that nothing comes back twice.
