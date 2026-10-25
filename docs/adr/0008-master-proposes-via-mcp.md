# 0008 · Master only proposes, through serenity's MCP tools

**Status:** Accepted · 2026-10-25

## Context
The master suggests replies, approvals, cleanups and review requests. Nothing should happen without the user's `y`.

## Decision
- serenityd runs an **MCP server** and passes it to every master role with `--mcp-config`. Tools include `suggest`, `set_summary`, `set_category`, `set_ask`, and `request_permission`.
- The master **never executes** actions on sessions. A `suggest` call creates a pending suggestion; serenity executes it deterministically only after `y` (or `e` then confirm).
- **Reading:** the master can read hook events and the repo read-only — `Read`, `Grep`, `Glob`, read-only `git` and `gh` commands.
- **Anything else** goes through `--permission-prompt-tool` to our `request_permission` tool, which shows a prompt in the master panel. The user approves or denies there.
- Destructive actions (stop session, remove worktree, delete branch) always go through the Confirm overlay (4b) with deterministic safety checks (uncommitted changes, unpushed commits, PR merged) computed by serenity, not the model.

## Consequences
- Executors for each suggestion kind live in the daemon and are unit-tested without a model.
- The permission prompt needs a small UI in the master panel (not on the canvas yet).
