# Architecture decisions

Each file records one decision: the context, what we chose, and what follows from it. A later ADR can supersede an earlier one; mark the old one `Superseded by NNNN` rather than editing history.

The screen specs live on the design canvas ([source](https://claude.ai/artifact/8c7QCT22YmUoADtsrzU6i7)) and are copied into [`docs/design/handover.md`](../design/handover.md). Where an ADR and the handover disagree, the ADR wins.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-product-scope-v1.md) | Product scope for v1 | Accepted |
| [0002](0002-typescript-ink-on-bun.md) | TypeScript + Ink on Bun, shipped as a compiled binary | Accepted |
| [0003](0003-hybrid-rendering.md) | Hybrid rendering: cell canvas for the map, Ink for panels | Accepted |
| [0004](0004-sessions-in-tmux-panes.md) | Claude Code sessions run in tmux panes | Amended by 0051 |
| [0005](0005-daemon-and-json-rpc.md) | Background daemon, JSON-RPC over a unix socket, scoped per repo | Amended by 0043, 0045 |
| [0006](0006-status-from-hooks.md) | Session status from Claude Code hooks, plus an exit report | Amended by 0044 |
| [0007](0007-master-roles-and-models.md) | Master = Opus stream + Haiku/Sonnet one-shot workers via the claude CLI | Amended by 0046, 0047 |
| [0008](0008-master-proposes-via-mcp.md) | Master only proposes; MCP tools for the Opus chat only | Amended by 0046 |
| [0009](0009-storage-interface-sqlite.md) | SQLite behind a swappable storage interface | Accepted |
| [0010](0010-worktrees-beside-repo.md) | New worktrees live beside the repo | Accepted |
| [0011](0011-pr-status-via-gh.md) | PR status via `gh`, refreshed on events | Amended by 0043 |
| [0012](0012-ux-decisions.md) | UX decisions not covered by the canvas | Accepted |
| [0013](0013-testing-strategy.md) | Testing strategy | Accepted |
| [0014](0014-distribution-and-release.md) | Distribution, release, licence, telemetry | Accepted |
| [0015](0015-workflow-and-milestones.md) | Workflow and milestones | Accepted |
| [0016](0016-importing-running-sessions.md) | Importing Claude sessions already running in tmux | Accepted |
| [0017](0017-topics-zoom-shows-every-topic.md) | The topics zoom shows every topic; "topic" replaces "category" | Accepted |
| [0018](0018-map-zoom-and-navigation.md) | Map zoom layout; `z` `Z` `Esc` `c` `/` `r` | Accepted |
| [0019](0019-topic-focus-shelves-and-topic-cap.md) | WASD between topics on the map; `z` out, `Z` in; shelves in the topics zoom; at most 10 topics; roomier master and cards | Amended by 0047 |
| [0020](0020-usage-bar.md) | Usage bar in the header: session and weekly plan limits from the status line, average wait on you | Accepted |
| [0021](0021-z-into-session-counts-in-header.md) | `Z` on a card attaches; session counts in the header, no SESSIONS section; roomier topics zoom | Accepted |
| [0022](0022-pinned-sessions.md) | `p` pins a session for reuse: a `pinned` topic, never done or cleaned up, resumed on attach | Amended by 0044 |
| [0023](0023-slack-for-the-master.md) | Slack for the master: threads and mentions waiting on you, per repo, read through Slack's MCP server; `[` `]` cycle them | Amended by 0031 |
| [0024](0024-slack-reply-suggestions.md) | Slack suggestions: a reply from sessions, PRs and reviews, or ask a session first; `y` posts it in the thread | Amended by 0050 |
| [0025](0025-install-script-and-homebrew.md) | Installer and Homebrew formula install tmux, git, gh and Claude Code too; release-please and the release workflow | Accepted |
| [0026](0026-arrows-between-nodes-enter-into-ctrl-m-master.md) | Arrow keys between nodes, Enter into a node and `w` `s` inside it, Esc out; `Ctrl+m` focuses the master from every view | Amended by 0051 |
| [0027](0027-master-centred-in-topics-zoom.md) | The master sits in the centre of the topics zoom, topics on both sides; docks left when too narrow | Accepted |
| [0028](0028-enter-attaches-enter-into-master-only.md) | Enter attaches a card and `i` messages it; only the master is gone into; WASD back beside the arrows; dim card frames; Slack keeps its place; MY PRS off | Accepted |
| [0029](0029-website-on-github-pages.md) | The website: static page on GitHub Pages at getserenity.dev, release version filled in at deploy | Accepted |
| [0030](0030-master-skill-auto-mode-confirmed-slack.md) | The master's skill, auto mode, and Slack messages sent once confirmed in the chat | Accepted |
| [0031](0031-slack-joins-needs-you.md) | Slack joins NEEDS YOU: only mentions and DMs that need an action, at most three; no SLACK section, `[` `]` back to topics | Amended by 0050 |
| [0032](0032-master-watches-sessions.md) | The master reads status on demand and watches sessions; hook status is checked against Claude's own | Amended by 0046 |
| [0033](0033-master-starts-sessions-from-a-brief.md) | The master starts sessions from a brief with `create_session` | Accepted |
| [0034](0034-dismiss-slack-items.md) | `x` dismisses a Slack item from NEEDS YOU for good, by message; a newer message in its thread shows again | Amended by 0050 |
| [0035](0035-master-sends-replies-the-user-asked-for.md) | The master sends replies the user asked for with `send_reply` | Accepted |
| [0036](0036-master-input-i-and-session-mentions.md) | `i` opens the master chat input and it stays open; `@session` tells the master to act on that session at once | Amended by 0037, 0048 |
| [0037](0037-mentions-relay-to-the-session.md) | An `@session` message is relayed to the session, questions answered by it; the master never looks into it | Accepted |
| [0038](0038-shift-enter-new-line-in-master-input.md) | Shift+Enter starts a new line in the master input (Alt+Enter, Ctrl+J as fallbacks); Enter sends | Accepted |
| [0039](0039-pulse-on-master-session-messages.md) | A card pulses magenta when the master messages it, the master when the session answers; `RepoState.pings` | Amended by 0042 |
| [0040](0040-master-queue.md) | The master's queue: replies its chat wants to send wait under NEEDS YOU, one line each, Enter shows one in full; Slack drafts stay in NEEDS YOU, marked `slack` | Amended by 0050 |
| [0041](0041-master-chat-scrolls.md) | The topics zoom's master shows four messages; `PgUp` `PgDn` (`Shift+↑↓`) scroll back and on; leaving resets it | Amended by 0042 |
| [0042](0042-master-shows-three-eased-pulse-text-fields-edit.md) | The master shows three messages, its scroll hints grey; the pulse is one eased swell, not three blinks; text fields edit at a cursor like a terminal line | Accepted |
| [0043](0043-dependency-retries-and-health.md) | gh, git and tmux calls retry with backoff and jitter, transient errors only, never anything unsafe twice; the map reconnects on its own (yellow, red after 15 s); dependencies failing call after call show as header badges | Accepted |
| [0044](0044-claude-restarts-in-its-pane.md) | Any claude exit serenity did not cause restarts it in the same pane with `--resume`, backing off 1–16 s; a sixth exit in 10 min, or one before it started, leaves the session dead with the reason | Accepted |
| [0045](0045-daemon-supervisor-crash-reports-recovery.md) | A supervisor restarts the daemon, crashes become deduped GitHub issues, and state survives a restart | Accepted |
| [0046](0046-master-survives-crashes-hangs-and-restarts.md) | The master survives crashes, hangs and daemon restarts: an outbox per repo, a 5-minute watchdog, restart with `--resume` and re-send, its state in SQLite, tools that answer within 2 minutes | Accepted |
| [0047](0047-finer-topics-moves-wait.md) | Finer topics: named for a feature or area, a new one for clearly distinct work; near-duplicate names join their topic; a topic move waits while the session works or the user types; `set_topic` stays immediate | Accepted |
| [0048](0048-at-new-starts-sessions-from-a-brief.md) | `@new <brief>` starts sessions at once, the master choosing the split, names and prompts; command words are never session names and lead the `@` list | Accepted |
| [0049](0049-copy-and-handover-docs.md) | `@copy @session` and `@handover @session`: the session writes a handover doc in its worktree, serenity copies it to its state; `@copy` starts a follow-up session carrying it, `@handover` gives its path, and it can go to Slack as a file once confirmed | Accepted |
| [0050](0050-needs-you-seen-and-explicit-actions.md) | NEEDS YOU: Enter marks an item seen (a Slack item dismissed and opened; a session hidden until it changes, never one waiting on you); ◆ says what `y` does to whom; Slack items you wrote after are read; Slack follow-ups reply, tell a session, or start one | Accepted |
| [0051](0051-ctrl-g-always-reaches-serenity.md) | Ctrl+g in an agent pane always reaches serenity: Ctrl+G and Ctrl+M (Caps Lock) bound too; the daemon puts back a lost pane marker or binding every 5 s and logs it; detach by pane prefers the live session | Accepted |

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
             │ MCP server for the chat (suggest / reply / topic / archive / open / watch …)    │
             │ master supervisor                                                                │
             │   ├─ Opus: long-lived `claude -p` stream-json  (chat; uses the MCP tools)       │
             │   ├─ Haiku: one-shot per event → JSON (summary, ask, finished, topic)        │
             │   └─ Sonnet: one-shot per event → JSON (one suggestion)                         │
             └──────────────────────────────────────────────────────────────────────────────────┘
```
