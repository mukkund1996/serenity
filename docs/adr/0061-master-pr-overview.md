# 0061 · The master gives an overview of the repo's open PRs with `pr_overview`: needs you, yours, others; one PR in depth on request

**Status:** Accepted · 2026-11-05 · Amends [0011](0011-pr-status-via-gh.md) (what the master reads from GitHub)

## Context
Users ask the master "what PRs are open?", "which PRs need my review?" or "how are my PRs doing?" (#105). The snapshot in each message has one line per session (`prLine()`), so the master saw only PRs that belong to a session on the map, and only their number and status word. It knew nothing of the repo's other open PRs, PRs asking the user for a review, or what a PR changes. It could run `gh pr list` itself, but then each answer costs a fresh, unshaped dump of gh output, and the master has to work out on its own which PRs wait on the user.

## Decision
- **One read-only serenity tool, `pr_overview`.** Without arguments it returns every open PR in the repo, sessions or not; with `pr` (123, "123" or "#123") that one PR in depth. It is read-only, so a call cut off by a daemon restart is retried (as `session_status`), and it is allowed without a prompt.
- **One gh call per overview, through the daemon's driver.** `Gh.openPrs` runs `gh pr list --state open --limit 51 --json number,url,title,author,isDraft,statusCheckRollup,reviewDecision,reviewRequests,headRefName,updatedAt`: retries and dependency health as every read (0043), at most 50 PRs, newest updated first, and it says when there were more. The list is cached per repo for 30 s, so a follow-up question costs nothing. A failed read after a good one gives the last list, said to be old; a first read that fails is a tool error saying why. "gh not logged in" and "gh not installed" say so and name the fix (`gh auth login`). The daemon's `TOOL_TIMEOUT_MS` (2 min) bounds the call like any other tool.
- **Joined with what serenity already knows.** The logged-in user from `Gh.currentUser` (cached), the review requests the ReviewWatcher already polls (these include team requests, which a login match alone misses), and the sessions on the map: a PR belongs to the session whose stored PR has its number, else to a session without a PR on its head branch. Archived sessions don't count.
- **Grouped, one line each.** `#41 "Add rate limits" by ana · no session · checks passing · review requested from you · waits on you: your review is requested`.
  - **Needs you:** someone else's PR asking for your review; your PR (not a draft) with changes requested, failing checks, or approved with checks passing ("ready to merge"); or any PR whose session waits on you. The line says why.
  - **Yours:** the rest of your PRs. Without a known gh user, PRs with a session count as yours.
  - **Others:** everything else.
  At most 10 lines per group, the rest counted. The tool's text ends by telling the master to answer grouped, one short line per PR, leaving out empty groups.
- **One PR in depth.** `Gh.prDetail` reads `gh pr view <n> --json <PR_FIELDS>,body,additions,deletions,headRefName`: title, author, state, head → base, session, checks, review state, size, the first 15 files and the description, clipped to 1,200 characters. For the code itself the master may run `gh pr diff`, now allowed without a prompt beside `gh pr view` and `gh pr list`.
- **The prompt and the skill.** `MASTER_SYSTEM_PROMPT` says to call `pr_overview` when the user asks about PRs, and lets an overview run past the 3-sentence limit at one short line per PR. The skill's "Which tool, and when" table has rows for an overview of the PRs and for one PR in depth, and a "PR overviews" section.
- **The snapshot is unchanged.** It still carries one PR line per session; the overview is fetched only when asked, so ordinary messages cost no extra gh call.

## Consequences
- An overview costs one `gh pr list` (plus `gh api user` the first time) at most every 30 s per repo, and only when the user asks. `statusCheckRollup` makes the list slower than a bare one, still well within the tool's timeout for 50 PRs.
- A repo with more than 50 open PRs shows the 50 most recently updated, and says so.
- Team review requests beyond the ReviewWatcher's three newest are not marked as needing the user; direct requests always are, from the PR's own reviewer list.
- The master can still run `gh pr list` and `gh pr view` itself; the skill steers it to `pr_overview` first.
- The daemon must restart to pick this up, and the master's plugin is rewritten on start, as for any skill change.
