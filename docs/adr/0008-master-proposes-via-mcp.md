# 0008 · Master only proposes, through serenity's MCP tools

**Status:** Accepted · 2026-10-25 · revised 2026-10-25 (MCP tools for the Opus chat only)

## Context
The master suggests replies, approvals, cleanups and review requests. Nothing should happen without the user's `y`. The Haiku and Sonnet workers return structured JSON (0007), so only the Opus chat needs tools.

## Decision
- serenityd exposes an **MCP server** to the Opus chat only, via `--mcp-config`. Tools:
  - `suggest` — creates a pending suggestion for a session (reply / approve / cleanup / review), e.g. when the chat offers "Want me to send it?".
  - `set_category` — moves a session, used only when the user asks for it.
  - `request_permission` — the `--permission-prompt-tool` target (below).
- The master **never executes** actions on sessions. A pending suggestion runs only after `y` (or `e` then confirm), executed deterministically by serenity.
- **Reading:** the chat can read hook events and the repo read-only — `Read`, `Grep`, `Glob`, read-only `git` and `gh` commands.
- **Anything else** goes through `--permission-prompt-tool` to `request_permission`, which shows a prompt in the master panel. The user approves or denies there.
- Destructive actions (stop session, remove worktree, delete branch) always go through the Confirm overlay (4b) with deterministic safety checks (uncommitted changes, unpushed commits, PR merged) computed by serenity, not the model.
- **Transport — open:** `claude` starts MCP servers itself, so the likely shape is a small `serenity mcp` stdio process that forwards to the daemon's socket. The alternative is the daemon serving MCP over HTTP on localhost.

## Consequences
- Executors for each suggestion kind live in the daemon and are unit-tested without a model.
- Worker suggestions (0007) and chat `suggest` calls create the same kind of pending suggestion.
- The permission prompt needs a small UI in the master panel (not on the canvas yet).
