# 0055 · A session's PR is found under the head it was pushed as, never dropped on a failure, and polled while open; the label is blue

**Status:** Accepted · 2026-11-02 · Amends [0011](0011-pr-status-via-gh.md) (finding, refreshing and showing a PR) and [0043](0043-dependency-retries-and-health.md) (a failed read)

## Context
The PR on a session's card came and went for the same session. Reading the watcher and probing gh 2.103 found these causes:
- **Stale writes.** `daemon.update` saved `{...session, ...patch}` from the caller's copy. The observer's sweep and attach/detach read a session, awaited tmux, then saved it. A PR the watcher stored in between was written back over with the old value.
- **Failures blanked the PR.** Only errors matching 0043's transient pattern kept the last PR. A rate limit (`HTTP 403 … secondary rate limit`, `API rate limit exceeded`), unreadable output or a momentary "not logged in" set `pr` to null until the next event.
- **The wrong head.** gh was asked about `session.branch`, fixed when the session started. An agent that ran `git checkout -b docs/X`, or pushed `X` as `fix/X`, had a PR gh could not find under `X`. gh does find merged and closed PRs by branch (checked: #78), but not a PR from a fork without `owner:branch` (checked: #79).
- **Refreshing.** A PR was read only on `Stop`, attach, detach and map open. Checks finishing, or a merge on GitHub, waited for the next event.

## Decision
- **A patch goes onto the stored row.** `update` and `change` merge into the session as it is in storage now, not as the caller last read it. No writer can put back a field it did not change.
- **No failure blanks a known PR.** Any error keeps the PR last read, with the reason beside it ("PR #74 checks passing" stays; the error is in `prError`). Transient errors read again as in 0043. A rate limit shows as `gh rate limited` and reads again after 1 min, doubling up to 10 min, five times at most. Polling pauses for the first minute. Lasting errors (not logged in) still wait for the next event.
- **Heads, most likely first** (`prHeads` in core, `resolveHeads` in the daemon), asked in turn until one has a PR or gh fails:
  1. The branch checked out in the session's worktree (an imported session's own directory), then `session.branch`.
  2. Before each of them, its upstream, when that is the same work renamed: `X` tracking `fix/X` or `docs/X`. A new worktree's branch tracks `origin/main`, and an upstream like `develop` is where it started, not its PR, so neither counts.
  3. Never the base branch (`origin/HEAD`) or a detached `HEAD`.
  4. With more than one remote (a fork), the pushed name is also tried as `owner:branch`, the owner taken from the remote's URL.
  A worktree that is gone falls back to `session.branch`.
- **A known PR is read by number** when no head has one: a branch deleted after the merge, or work moved to a new branch, keeps the PR, merged state included. A new PR on a head replaces it.
- **Refreshed promptly.**
  - A `PostToolUse` of Bash running `git push` or `gh pr create|merge|ready|close|reopen|edit` refreshes the PR (debounced), as `Stop` does.
  - While a map of the repo is open, open PRs are polled: every minute while checks run, every 3 minutes otherwise (`SERENITY_PR_POLL_MS`, the tick, default 60 s; 0 turns polling off). Merged, closed and not-yet-opened PRs wait for events. Polling stops when no map of the repo is open.
- **Style.** `PR #74` is bright blue on the card, in the attach panel's ABOUT THIS SESSION, and as `#41` in the master's REVIEW rows (`PR_LABEL_COLOR`). Bright, as for mentions (0052), since plain blue is hard to read on dark terminals. The status word after it keeps its 0011 tone (merged cyan, passing/approved green, failing red, changes requested yellow, the rest grey), so card and panel read alike. "no PR yet" and "PR unknown · …" stay dim grey. The number is no longer underlined; `o` still opens it. NEEDS YOU shows no PR, unchanged.

## Consequences
- An open map costs one `gh pr view` per open PR per minute while checks run, a third of that otherwise. Ten sessions with running checks is about 600 calls an hour, within GitHub's 5,000.
- A session that moved on to a new branch shows its old PR until the new one opens. A pinned session (0022) does too.
- A session with no PR yet can cost one gh call per head on each event. Usually that is one or two calls, three or four with a fork's remotes.
- Renamed and same-name sessions (#35) need nothing: the watcher keys everything by session id, and heads come from git, not the name.
- The daemon must restart to pick this up.
