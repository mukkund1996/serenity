# Architecture decisions

Each file records one decision: the context, what we chose, and what follows from it. A later ADR can supersede an earlier one; mark the old one `Superseded by NNNN` rather than editing history.

The screen specs live on the design canvas ([source](https://claude.ai/artifact/8c7QCT22YmUoADtsrzU6i7)) and are copied into [`docs/design/handover.md`](../design/handover.md). Where an ADR and the handover disagree, the ADR wins.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-product-scope-v1.md) | Product scope for v1 | Accepted |
| [0002](0002-typescript-ink-on-bun.md) | TypeScript + Ink on Bun, shipped as a compiled binary | Accepted |
| [0003](0003-hybrid-rendering.md) | Hybrid rendering: cell canvas for the map, Ink for panels | Accepted |
| [0004](0004-sessions-in-tmux-panes.md) | Claude Code sessions run in tmux panes | Accepted |
| [0005](0005-daemon-and-json-rpc.md) | Background daemon, JSON-RPC over a unix socket, scoped per repo | Accepted |
| [0006](0006-status-from-hooks.md) | Session status from Claude Code hooks, plus an exit report | Accepted |
| [0007](0007-master-roles-and-models.md) | Master = Opus stream + Haiku/Sonnet one-shot workers via the claude CLI | Accepted |
| [0008](0008-master-proposes-via-mcp.md) | Master only proposes; MCP tools for the Opus chat only | Accepted |
| [0009](0009-storage-interface-sqlite.md) | SQLite behind a swappable storage interface | Accepted |
| [0010](0010-worktrees-beside-repo.md) | New worktrees live beside the repo | Accepted |
| [0011](0011-pr-status-via-gh.md) | PR status via `gh`, refreshed on events | Accepted |
| [0012](0012-ux-decisions.md) | UX decisions not covered by the canvas | Accepted |
| [0013](0013-testing-strategy.md) | Testing strategy | Accepted |
| [0014](0014-distribution-and-release.md) | Distribution, release, licence, telemetry | Accepted |
| [0015](0015-workflow-and-milestones.md) | Workflow and milestones | Accepted |
| [0016](0016-importing-running-sessions.md) | Importing Claude sessions already running in tmux | Accepted |
| [0017](0017-topics-zoom-shows-every-topic.md) | The topics zoom shows every topic; "topic" replaces "category" | Accepted |
| [0018](0018-map-zoom-and-navigation.md) | Map zoom layout; `z` `Z` `Esc` `c` `/` `r` | Accepted |
| [0019](0019-topic-focus-shelves-and-topic-cap.md) | WASD between topics on the map; `z` out, `Z` in; shelves in the topics zoom; at most 10 topics; roomier master and cards | Accepted |
| [0020](0020-usage-bar.md) | Usage bar in the header: session and weekly plan limits from the status line, average wait on you | Accepted |
| [0021](0021-z-into-session-counts-in-header.md) | `Z` on a card attaches; session counts in the header, no SESSIONS section; roomier topics zoom | Accepted |
| [0022](0022-pinned-sessions.md) | `p` pins a session for reuse: a `pinned` topic, never done or cleaned up, resumed on attach | Accepted |
| [0023](0023-slack-for-the-master.md) | Slack for the master: threads and mentions waiting on you, per repo, read through Slack's MCP server; `[` `]` cycle them | Accepted |
| [0024](0024-slack-reply-suggestions.md) | Slack suggestions: a reply from sessions, PRs and reviews, or ask a session first; `y` posts it in the thread | Accepted |
| [0025](0025-install-script-and-homebrew.md) | Installer and Homebrew formula install tmux, git, gh and Claude Code too; release-please and the release workflow | Accepted |
| [0026](0026-arrows-between-nodes-enter-into-ctrl-m-master.md) | Arrow keys between nodes, Enter into a node and `w` `s` inside it, Esc out; `Ctrl+m` focuses the master from every view | Accepted |
| [0027](0027-master-centred-in-topics-zoom.md) | The master sits in the centre of the topics zoom, topics on both sides; docks left when too narrow | Accepted |

## System at a glance

All `claude` processes run on the user's own Claude login (0007).

```
 terminal ── tmux session "serenity-<repo>"
             ├─ pane: serenity TUI (Ink) ─────────┐
             └─ panes: claude (one per session)   │ JSON-RPC over
                  │ hooks: `serenity hook <event>`│ unix socket
                  ▼                               ▼
             ┌──────────────── serenityd (one per machine, state keyed by repo) ───────────────┐
             │ session registry · status reducer · tmux driver · git/worktree driver · gh driver │
             │ storage (interface) ── SQLite                                                    │
             │ MCP server for the chat (suggest / set_topic / archive / open / permission)     │
             │ master supervisor                                                                │
             │   ├─ Opus: long-lived `claude -p` stream-json  (chat; uses the MCP tools)       │
             │   ├─ Haiku: one-shot per event → JSON (summary, ask, finished, topic)        │
             │   └─ Sonnet: one-shot per event → JSON (one suggestion)                         │
             └──────────────────────────────────────────────────────────────────────────────────┘
```
