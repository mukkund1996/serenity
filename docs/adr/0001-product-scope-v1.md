# 0001 · Product scope for v1

**Status:** Accepted · 2026-10-25

## Context
serenity is a keyboard-only terminal app that shows every Claude Code session as a node on a mind map around one master agent (design canvas: "Agent Mind Map CLI — Screens").

## Decision
- **Audience:** public, open source. No hardcoded personal setup; everything user-specific comes from config or the repo.
- **Zoom levels:** all three in v1 — map, topics, session.
- **Master:** full in v1 — summaries, NEEDS YOU list, `y`/`e`/`n` suggestions, master-owned categories, chat.
- **Sessions:** only sessions serenity spawns. No discovery or import of existing Claude sessions.
- **GitHub PRs:** in v1, via the `gh` CLI (see 0011).
- **Platforms:** macOS and Linux.
- **One map per repo:** serenity is scoped to the repo it is launched in.

## Out of v1
- Slack (draft overlay 4c, review-request pings over Slack).
- Master expanded view (`M`) — v1.1.
- Importing existing sessions; `tmux capture-pane` status fallback.
- Mouse support, keymap rebinding, Windows/WSL.

## Consequences
- "Request review from a teammate" in v1 uses `gh pr edit --add-reviewer`, not Slack.
- A public audience means a doctor check, clear errors and install docs are part of v1, not polish.
