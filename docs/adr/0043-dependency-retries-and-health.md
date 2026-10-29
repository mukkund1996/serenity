# 0043 · Calls to dependencies retry with backoff; the map reconnects on its own; failures that last show in the header

**Status:** Accepted · 2026-10-29 · Amends [0005](0005-daemon-and-json-rpc.md) (reconnecting) and [0011](0011-pr-status-via-gh.md) (a failed read)

## Context
serenity leans on things it does not control: its own daemon over a unix socket, tmux, git, gh, and Slack through a Claude worker. An audit found that a single blip went a long way.
- **The map** reconnected every second for good, but showed a red `daemon down` from the first second, and a keypress made while it was away failed at once.
- **gh** was run once. A 502 or a timeout put its error on the card and dropped the PR until the next event, which could be a long time coming. `currentUser` kept a failure for the daemon's life, so reviewer suggestions stopped until it restarted.
- **git and tmux** went through `exec.run` once. A held `index.lock` or a tmux server busy for a moment failed the call.
- **Slack** was read again only at the next poll, a minute later.
- Nothing said a dependency had been failing for a while; it showed up as one card's error, or only in `daemon.log`.

SQLite needed nothing: it is WAL with a 2 s `busy_timeout`, and only the daemon writes. The CLI's `serenity hook`, `exited` and `statusline` already wait for the daemon (`ensureDaemon`, up to 3 s) before their one request, and a request is not sent twice (below).

## Decision
- **One helper.** `withRetry` in `@serenity/core` (`retry.ts`) retries with exponential backoff and full jitter: retry *n* waits a random time in [0, min(max, base·2ⁿ)]. Only errors a classifier calls transient are retried. Anything else is thrown at once.
- **Transient vs permanent.** Transient means timeouts, dropped or refused connections, `EAGAIN`, HTTP 5xx, TLS and DNS failures, a git lock (`index.lock`, `cannot lock ref`), and a tmux server lost mid-call. These may pass on their own. Auth (`gh auth login`), "not found", no tmux server, a missing binary and HTTP 4xx are permanent: retrying would only fail again. For RPC, a timeout or a closed connection is transient and a handler's error is not.
- **What retries, and how much.** The daemon's gh, git and tmux calls make 3 tries, with backoff from 200 ms capped at 2 s, so about 2 s at worst. Only calls that are safe to run twice retry:

  | Retried | Never retried |
  |---------|---------------|
  | gh `pr view`, `pr list`, `api user` | gh `pr edit --add-reviewer` |
  | git `rev-parse`, `symbolic-ref`, `status`, `rev-list`, `worktree prune` | git `worktree add` / `remove`, `branch -d` |
  | tmux `has-session`, `display-message`, `show-options`, `capture-pane`, `list-clients`, `select-pane`, `switch-client`, `rename-window`, `bind-key`, `set-option` (not `-a`) | tmux `send-keys`, `new-session`, `new-window`, `join-pane`, `break-pane`, `respawn-pane`, `kill-pane`, `set-option -a` |

  `run(command, { retry: true })` opts in. The tmux driver decides by subcommand (`isIdempotent`). A keystroke typed twice into a Claude pane is worse than one that failed visibly.
- **A blip keeps the last good data.** When gh fails transiently after its own retries, the card keeps the PR it last read, with the error beside it. The PR is read again with backoff (5 s up to 60 s, at most 5 times) instead of waiting for the next event. `currentUser` is asked again after a failure. A failed Slack read is tried again after 15 s, then further apart, never later than the next poll. Slack already kept its last items.
- **The map reconnects on its own** (`DaemonLink`, `tui/src/daemon-link.ts`). It retries forever with backoff from 250 ms capped at 5 s. The last state stays on screen, and the header shows a yellow ` reconnecting… ` (` connecting… ` at start). After 15 s without the daemon it turns red: ` daemon down · see daemon.log `. Once the daemon has been away 3 s the map starts one, once per outage, as before (0005). A keypress that needs the daemon waits up to 3 s for the link. If the link is still down it fails with `not sent: daemon unreachable` in the notice line. Nothing is queued to run later: a stale "accept" or "kill" sent minutes on would surprise.
- **Failures that last show in the header.** The daemon keeps `DependencyHealth` for gh, git, tmux and Slack. Every call reports to it through `onDependency` in `exec.ts`:
  - the dependency answered, which includes "no PR" and "no such branch": healthy;
  - it failed transiently after its retries: unreachable;
  - its binary is missing, or gh is logged out: that reason.

  Two failures in a row report the dependency down, and its next success clears it. `RepoState.health` carries the list, and the header shows a red badge for each, such as ` gh not logged in ` or ` tmux unreachable `. A Slack problem shows only on maps of repos with Slack on. Card errors and Slack's own error stay as they were. The first failure in a row is logged.

## Consequences
- A dependency that is really down costs about 2 s per call before it fails. The watchers run in the background, so the map does not wait on them; an action from a keypress can take that much longer to fail.
- A 4xx from gh, such as a secondary rate limit, is not retried; the next event or poll reads it again.
- `serenity hook` and `exited` still send their one request once. If the daemon dies after receiving it and before answering, that event is lost rather than risked twice.
- Restarting a crashed daemon beyond the existing start-on-outage, respawning Claude in a pane, and the master's own robustness are out of scope here.
- The badge threshold and backoffs are constants (`FAILURES_TO_REPORT`, `DEPENDENCY_RETRY`, `RECONNECT_BACKOFF`, `PR_RETRY`, `SLACK_RETRY`), not config.
