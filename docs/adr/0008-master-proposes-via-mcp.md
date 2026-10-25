# 0008 · Master only proposes, through serenity's MCP tools

**Status:** Accepted · 2026-10-25 · revised 2026-10-25 (MCP tools for the Opus chat only; stdio proxy; permission UI)

## Context
The master suggests replies, approvals and cleanups (review requests come with PRs in milestone 3). Nothing should happen without the user's `y`. The Haiku and Sonnet workers return structured JSON (0007), so only the Opus chat needs tools.

## Decision
- serenityd exposes an **MCP server** to the Opus chat only, via `--mcp-config`. Tools:
  - `suggest` — creates a pending suggestion for a session (reply / approve / cleanup), e.g. when the chat offers "Want me to send it?". serenity checks it fits the session (no approve unless it waits on a permission prompt).
  - `set_topic` — moves a session, used only when the user asks for it.
  - `request_permission` — the `--permission-prompt-tool` target (below).
- The master **never executes** actions on sessions. A pending suggestion runs only after `y` (or `e` then confirm), executed deterministically by serenity.
- **Reading:** the chat can read the repo read-only — `Read`, `Grep`, `Glob`, and `git log/diff/status/show/branch`, `gh pr view/list`. These and serenity's own `suggest` / `set_topic` are pre-allowed with `--allowedTools`; without that, `claude` routes even our own tools through the permission tool.
- **Anything else** goes through `--permission-prompt-tool` to `request_permission`. The call waits; serenity shows "◆ master wants to use <tool> · <command>" at the top of NEEDS YOU, `y` allows and `n` denies, answering `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny",…}`. Unanswered after 10 minutes, it is denied.
- **Executors:** reply types the text into the agent's pane; approve presses `1` ("Yes" in Claude Code's numbered permission menu) and only while the session waits on a permission prompt; cleanup stops the agent, removes its worktree and deletes its branch.
- **Cleanup safety** is computed by serenity from git, never by the model: a worktree with uncommitted changes is kept, a branch is deleted only if serenity created it and it is merged into the base (and not checked out in a kept worktree). `y` on a cleanup that would keep something opens the Confirm overlay (4b); `x` and `e` always do.
- **Transport:** `claude` starts `serenity mcp <repo>`, a small stdio MCP server that forwards each tool call to the daemon over the socket (`master.tool`). The config is passed inline as JSON to `--mcp-config`; no file or port.

## Consequences
- Executors for each suggestion kind live in the daemon and are unit-tested without a model.
- Worker suggestions (0007) and chat `suggest` calls create the same kind of pending suggestion.
- The repo is identified by its real path (as `git rev-parse --show-toplevel` gives it); requests for another spelling of the path go to a map that is not shown.
