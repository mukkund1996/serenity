# 0015 · Workflow and milestones

**Status:** Accepted · 2026-10-25

## Workflow
- Commit straight to `main` while the project is young; conventional commit messages (needed by release-please).
- Milestones and work items are GitHub milestones + issues in this repo.
- Decisions get an ADR here.

## Milestones
1. ✓ **Walking skeleton** — monorepo, Biome, CI; daemon auto-start + JSON-RPC; storage interface + SQLite; tmux bootstrap; spawn a session (new worktree / existing branch) with hooks; status reducer; topics zoom with real statuses (no master); attach / `Ctrl+g` spike; doctor; too-small screen.
2. ✓ **Master** — MCP server; Opus chat stream; Haiku summarizer + finished judgement; Sonnet suggester; NEEDS YOU; `y`/`e`/`n`; Reply (4a), Confirm (4b), permission prompt; categories; watch; spinner; failure chips.
3. ✓ **PRs** — `gh` refresh on events, card PR line, `o`, review-request suggestion.
4. **Map and navigation** — map zoom (1), category ranking and the "N more categories" node, expand (2b), WASD, `c`, `z`/`Z`, `[`/`]`, `/` search, rename / remove, shortcuts panel (4e).
5. **Release** — release-please, binary matrix, Homebrew tap, curl installer, README, LICENSE.

**v1.1:** master expanded view (`M`). **Later:** Slack, importing sessions, richer event capture, keymap config.
