# 0011 · PR status via `gh`, refreshed on events

**Status:** Accepted · 2026-10-25

## Decision
- PR data comes from `gh pr view <branch> --json number,url,state,isDraft,statusCheckRollup,reviewDecision` run in the session's worktree.
- Refreshed **only on events**: after each `Stop` hook, on attach/detach, and on demand. No background polling.
- Status words: checks failing / checks running / checks passing / approved / merged / draft.
- `o` opens the PR URL in the browser. Review requests use `gh pr edit --add-reviewer` (Slack is v2).

## Consequences
- A PR can look stale while its session is idle; acceptable for v1. Revisit with polling if it bites.
- `gh` missing or not authenticated → per-card notice, never a crash; doctor reports it.
