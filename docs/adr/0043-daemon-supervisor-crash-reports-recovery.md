# 0043 · A supervisor restarts the daemon, crashes become deduped GitHub issues, and state survives a restart

**Status:** Accepted · 2026-10-29 · Amends [0005](0005-daemon-and-json-rpc.md) (how the daemon starts, crash safety)

## Context
When serenityd died, nothing brought it back until a client happened to call `ensureDaemon` (a hook, a reconnecting map). Nobody learned why it died: the error went to `daemon.log` and stayed there. A restart also lost what the daemon held only in memory: the attached session (its pane stayed joined beside the map with no way to detach it), plan usage, which reviewers were already offered (a declined offer came back), and the startup timers of new sessions. Sessions whose panes closed while no daemon ran stayed "working" forever.

## Decision
- **A supervisor process, not launchd or systemd.** `serenity daemon` is now a small supervisor that runs `serenity daemon --worker`, the daemon itself, and restarts it when it exits with anything but 0. It works the same on macOS and Linux, needs nothing installed, and starts the way the daemon always has (0005: the first client starts it). An OS service would have survived reboots and the supervisor itself dying. It would also need a separate install and uninstall for each platform, and it would fight the build handshake: a new build asks the old daemon to go, and launchd would bring the old one back. `ensureDaemon` still covers the supervisor itself: if it is gone, the next client starts a new one.
  - **Backoff:** 500 ms before the first restart, doubling per crash, at most 30 s.
  - **Crash loop:** 5 crashes within 5 minutes and the supervisor gives up (exit 1, `giving up` in the log). A later client starts a fresh one. Crashes older than the window stop counting, so a daemon that ran for a while starts again from the short backoff.
  - **A clean exit ends it:** `serenity stop`, `restart` and a new build's handshake ask the worker to shut down; it exits 0 and the supervisor follows. SIGTERM to the supervisor stops the worker cleanly first.
  - **One supervisor per home**, held by `daemon.lock` (its pid; a dead pid's lock is taken over). A second supervisor leaves at once while the first is alive, even during a backoff, when the socket is briefly gone and a hook may try to start the daemon. Whoever asks a daemon to go (`serenity stop`, the handshake) waits for its socket and then its lock to clear before starting another.
- **Crash reports.** A worker that dies of an uncaught exception or an unhandled rejection writes the error to `crash.json` and exits 70. Its supervisor reads that file, so a report goes out even when the worker died hard. A worker killed by a signal with nothing recorded (`kill -9`, the OOM killer) is restarted but not reported: the cause is outside serenity's code. Any other non-zero exit is reported as `Exit`.
  - **Consent:** issues are filed only with `crashReports.enabled: true` in the config. It is off by default. Every report is still written to `crash-reports/` in the state directory, so the user can read exactly what would be sent before turning it on.
  - **Where:** `crashReports.repo`, `mukkund1996/serenity` by default, through the user's own `gh`.
  - **What a report holds:** the error's name, message and stack; the build (`BUILD_ID`); the OS (platform, release, arch) and the Bun version; the last 40 lines of `daemon.log`. Before anything is written it is scrubbed. GitHub, Slack, Anthropic and JWT tokens, `Bearer`/`token` values, `key=`/`secret=`/`password=` values, URL credentials and email addresses are removed. Every path becomes `<path>` (paths name the user and their repos), except serenity's own source files, which keep the part from `packages/` on. The user name becomes `<user>`.
  - **Dedupe:** a crash signature is the first 12 hex digits of a sha256 over the error's name, its message with ids, numbers and quoted strings taken out, and the top three frames (function and file, no line numbers, serenity's own frames first). The issue title ends in `(sig:<signature>)`. Before filing, the reporter searches the repo's open issues for that signature. If one is open it comments there; otherwise it files a new issue, so a crash that comes back after its issue was closed gets a fresh one.
  - **Rate limit:** at most one GitHub write per signature every 6 hours, and 5 a day across all signatures. Occurrences in between are counted and the next comment says how many. A failed `gh` call counts as a write, so a broken `gh` is not retried on every crash. Restarts never wait for a report, but the supervisor finishes its reports before it exits.
- **State survives a restart.** A new `recovery` store in Storage (ADR 0009; a `recovery` table in SQLite, one JSON value per key) keeps what the daemon otherwise held only in memory and needs after a restart:
  - `attached`: the session attached beside each map, stored on every attach, detach and end.
  - `usage`: the last plan usage report.
  - `offeredReviews`: `session:pr` pairs already offered a reviewer, the latest 500.
  The last hook of each session is read back from the events table. Everything else was already in SQLite: sessions, suggestions (the queue), the conversation, waits, Slack dismissals.
- **Reconcile on start.** Before it listens, the daemon matches storage to tmux and git (`recoveryPlan` in `recover.ts`, a pure function):
  - A hook-tracked session whose pane closed while no daemon ran is marked ended. Observed sessions are left to the observer's sweep, which checks their claude process.
  - A worktree folder deleted behind serenity's back is cleared from its session, so cleanup does not try to remove it.
  - An attachment is kept only while both its panes live. A spawned session left joined beside a map that is gone is parked back in its own window.
  - A session still waiting for its first hook gets its startup grace timer again.
- **Not persisted, and why:**
  - Map subscriptions and map panes: clients reconnect and subscribe again.
  - PR and review-request caches: they are refetched when a map opens.
  - The Slack inbox and its reply suggestions: the next poll rebuilds them.
  - What `master.ts` keeps: chat processes, pending permissions, watches, sends awaiting an answer. That file belongs to master-robustness; its chat processes die with the daemon, and a pending permission cannot outlive the chat that asked.

## Consequences
- `kill -9` of the worker brings a new one back within a second, with its sessions, attachment, usage and queue as they were.
- Two processes per home instead of one. The supervisor holds no state, and its log lines start with `supervisor:`.
- `serenity daemon` without `--worker` starts a supervisor. Anything that ran the daemon directly in the foreground now gets a supervisor in front of it, which behaves the same way for `stop`.
- `SERENITY_SUPERVISOR_BACKOFF_MS` and `SERENITY_SUPERVISOR_CRASH_LIMIT` shorten the policy for tests. `SERENITY_DEBUG_CRASH=<message>` makes a worker throw 200 ms after it starts, to exercise the crash path.
- Respawning Claude sessions, retrying tmux, gh and Slack, and keeping the master's own state across restarts are left to the work that owns them.
