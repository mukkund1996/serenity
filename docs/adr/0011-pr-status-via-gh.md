# 0011 · PR status via `gh`, refreshed on events

**Status:** Accepted · 2026-10-25 · revised 2026-10-25 (milestone 3: reviewers, merged PRs, squash merges) · revised 2026-10-26 (review requests for the master panel)

## Decision
- PR data comes from `gh pr view <branch> --json number,url,title,state,isDraft,statusCheckRollup,reviewDecision,reviewRequests,latestReviews,author,headRefOid,baseRefName,files`, run in the session's worktree.
- Refreshed **only on events**, never polled: after each `Stop` hook (debounced), on attach and detach, when a map opens (at most once a minute per session), and right after a review request.
- Checks roll up as: any failure → failing; anything not finished → running; otherwise passing; no checks → none.
- Status words on the card, most important first: merged · closed · draft · checks failing · changes requested · checks running · approved · checks passing · open. Colours: merged cyan, passing/approved green, failing red, changes requested yellow, the rest grey.
- `o` opens the PR URL in the browser.
- **Merged means finished:** a merged PR turns an idle session done (spawned sessions only; imported ones often share a checkout, 0016), which brings the master's cleanup suggestion. A done session whose PR merges later gets a new suggestion; no cleanup is suggested while its PR is open.
- **Review requests** are deterministic, no model call: when a PR is open, not a draft, checks passing or none, and nobody is requested or has reviewed, serenity suggests "Request review from @<login>". The reviewer is the first CODEOWNER of the PR's changed files (`.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`; last matching rule wins), else the first of `reviewers` in `~/.config/serenity/config.json`, never the PR's author or the current `gh` user. Offered once per PR, so a decline sticks. `y` runs `gh pr edit <n> --add-reviewer <login>`; `e` edits the login first. Slack is v2.
- **Squash and rebase merges:** git sees such a branch as unmerged. Cleanup still deletes it (`git branch -D`) when the merged PR's head commit is the branch's current commit, so nothing on it is lost; the Confirm overlay names "PR #<n> merged" as the safety fact. Otherwise the branch is kept.
- **Review requests for the user** (the master's REVIEW section, 0012) come from `gh pr list --search "review-requested:@me sort:updated-desc" --state open --limit 3 --json number,url,title,author,updatedAt`, run in the repo, so only this repo's PRs show. No serenity event fires when someone asks the user for a review, so this one list is **polled**: on opening a map (at most once a minute), then every 5 minutes while a map of the repo is open (`SERENITY_REVIEW_POLL_MS`). Polling stops when no map is open. A failed call keeps the last list.
- **My PRs** (the master's MY PRS section) are not fetched separately: they are the open PRs of the sessions on the map whose author is the `gh` user, one row per PR.
- `SERENITY_GH_BIN` points serenity at another `gh` (the E2E fake).

## Consequences
- A PR can look stale while its session is idle and the map is closed; acceptable for v1. Revisit with polling if it bites.
- An open map costs one `gh pr list` call every 5 minutes; review requests can be up to 5 minutes late.
- `gh` missing or not logged in shows on the card as "PR unknown · <reason>", never a crash; "no PR yet" and repos without a GitHub remote stay quiet.
- Teams named in CODEOWNERS (`@org/team`) can be suggested; `gh` accepts them as reviewers.
