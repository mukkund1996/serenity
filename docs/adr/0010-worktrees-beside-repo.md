# 0010 · New worktrees live beside the repo

**Status:** Accepted · 2026-10-25

## Decision
The New session form (4d) offers "new worktree" or "existing branch". A new worktree is created as a sibling of the repo: `<parent>/<repo>-<session-name>` (e.g. `~/repos/perry-studio-editor`), on branch `<session-name>` from the current default branch.

## Consequences
- Names are sanitised and collisions get a numeric suffix.
- Cleanup removes the worktree and deletes the branch only after the safety checks in 0008.
