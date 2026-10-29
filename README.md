<div align="center">

<a href="https://getserenity.dev"><img src="website/favicon.svg" alt="serenity" width="88" height="88"></a>

# serenity

**One calm map for your Claude Code sessions.**

Every session is a node on a mind map around one master agent.<br>
Working agents stay quiet. Waiting agents call you. The master keeps the overview.

[![CI](https://github.com/mukkund1996/serenity/actions/workflows/ci.yml/badge.svg)](https://github.com/mukkund1996/serenity/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mukkund1996/serenity?color=7fc77f&label=release)](https://github.com/mukkund1996/serenity/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-7fc77f)](LICENSE)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-858c97)

[**Website**](https://getserenity.dev) · [**Install**](#install) · [**How it works**](#how-it-works) · [**Keys**](#keys) · [**Configuration**](#configuration) · [**Docs**](docs/adr/README.md)

</div>

---

## Why serenity

It starts with one Claude session. Then there are six, spread across tmux windows, worktrees and PRs, and you spend your day tabbing between them to find the one that is waiting on you.

serenity puts them all on one keyboard-driven map in your terminal:

- **Harmony instead of clutter.** Every Claude Code session is a node, grouped into topics the master picks for you.
- **Focus instead of distraction.** Working agents stay grey and quiet. An agent that needs an answer turns yellow and moves to the top.
- **Clarity instead of noise.** The master agent summarises every session, suggests the next step, and acts on it when you press `y`.

serenity runs on your existing Claude Code login and subscription.

> [!NOTE]
> serenity is in **beta**. Expect rough edges and changes between releases.

## Features

| | |
|---|---|
| **Mind map of sessions** | Three zoom levels: the **map** (master in the centre, topics around it), **topics** (every session as a card with its summary and PR), and **session** (the real Claude Code pane, untouched). |
| **Live status** | Sessions report through Claude Code hooks: `◐` waiting, `●` working, `✓` finished. Only waiting sessions ask for attention. |
| **The master** | Haiku writes one-line summaries and groups sessions into topics, Sonnet suggests replies, approvals and cleanups you accept with `y` / `e` / `n`, and an Opus chat (`i` on the master) can see and steer everything, start new sessions from a brief, and relay to any session you tag with `@name`, condensing its answer when you asked a question. |
| **Pull requests** | Each card shows its PR and checks via `gh`. `o` opens it, ready PRs get a review request from CODEOWNERS, and a merged PR finishes the session. |
| **Safe cleanup** | Removing a session checks for uncommitted changes, unpushed commits and PR state before it touches a worktree. |
| **Worktrees** | New sessions get their own git worktree beside the repo, or reuse an existing branch. |
| **Import** | Claude sessions you already run in tmux join the map with `I` and stay in their windows. |
| **Pinned sessions** | `p` pins a session you reuse: it is never marked finished or cleaned up, and resumes with `claude --resume` when you attach after it ended. |
| **Slack (optional)** | Mentions and DMs that need you to act, at most three, join NEEDS YOU. The master drafts a reply from your sessions and PRs; `y` posts it, `x` dismisses the item for good. |

## Install

macOS or Linux. One command installs serenity and anything it needs that you don't have yet: [tmux](https://github.com/tmux/tmux) 3.2+, git, [`gh`](https://cli.github.com) and [Claude Code](https://claude.com/claude-code).

```bash
curl -fsSL https://raw.githubusercontent.com/mukkund1996/serenity/main/scripts/install.sh | sh
```

Or with Homebrew (tmux, git and gh come as dependencies; Claude Code is a cask):

```bash
brew install --cask claude-code; brew install mukkund1996/tap/serenity
```

The install script reads these environment variables:

| Variable | Default | Effect |
|----------|---------|--------|
| `SERENITY_VERSION` | latest release | Install a specific version |
| `SERENITY_INSTALL_DIR` | `~/.local/bin` | Where the binary goes |
| `SERENITY_NO_DEPS` | unset | Set to `1` to skip installing dependencies |

## Quick start

```bash
gh auth login     # optional: PR status on cards (without it, cards say why)
cd ~/your/repo
serenity          # opens the map for this repo
```

`serenity doctor` checks your setup. Press `N` to start a session, `?` for the full keymap.

| Command | What it does |
|---------|--------------|
| `serenity` | Open the map for the git repo you are in |
| `serenity doctor` | Check tmux, claude, git and gh |
| `serenity slack login` | Sign in to Slack for the master (once) |
| `serenity restart` | Restart the background daemon (sessions keep running) |
| `serenity stop` | Stop the background daemon |
| `serenity version` | Print the version |

## How it works

```
                 ┌────────────── serenity TUI (Ink) ──────────────┐
   you ── keys ─▶│  map  ›  topics  ›  session                    │
                 └───────────────────────┬────────────────────────┘
                                         │ JSON-RPC over a socket
                 ┌───────────────────────▼────────────────────────┐
                 │  daemon   SQLite state · master (Haiku/Sonnet/ │
                 │           Opus via Claude Code) · gh · Slack   │
                 └───────┬───────────────────────────────┬────────┘
                         │ tmux panes                    │ hooks
                 ┌───────▼───────┐  ┌───────────────┐    │
                 │ claude (wt 1) │  │ claude (wt 2) │ ◀──┘ status
                 └───────────────┘  └───────────────┘
```

- Each session is a real `claude` process in its own tmux pane, usually in its own git worktree. Attaching shows you that pane as it is.
- A background daemon owns the state (SQLite), receives status from Claude Code hooks, polls PRs through `gh`, and runs the master.
- The master proposes actions through MCP; nothing runs until you approve it.
- One map per repo: serenity is scoped to the repo you launch it in.

The reasoning behind each of these choices is in the [architecture decision records](docs/adr/README.md).

## Keys

serenity is keyboard-only. The footer shows the moves; `?` opens the full list.

| Key | Action |
|-----|--------|
| `←` `↑` `↓` `→` / `WASD` | Move between nodes |
| `Enter` | Attach to a session, or go into the master |
| `i` | Send the focused session a quick message; on the master, open its chat input (`@` tags a session, `Shift+Enter` or `Ctrl+J` starts a new line, `Esc` closes it) |
| `Ctrl+g` | Back to the map from inside a session |
| `z` / `Z` / `Esc` | Zoom out to the map / zoom in / one level up |
| `Ctrl+m` | Focus the master from anywhere (Enter in Apple Terminal) |
| `PgUp` `PgDn` | On the master, scroll its conversation back and on (`Shift+↑` `Shift+↓` too) |
| `Tab` | Jump to the next session that needs you |
| `y` `e` `n` | Approve, edit or decline the master's suggestion |
| `[` `]` | Previous / next topic |
| `N` `I` | New session · import from tmux |
| `o` `f` `p` | Open the PR · watch · pin |
| `r` `K` `x` | Rename · kill the agent · clean up; on a Slack item, `x` dismisses it |
| `/` `c` `H` | Search sessions · centre on the master · archived sessions |

## Configuration

Config lives in `~/.config/serenity/config.json`. Every field is optional.

```json
{
  "models": { "chat": "opus", "summarizer": "haiku", "suggester": "sonnet" },
  "reviewers": ["teammate-login"],
  "maxTopics": 10,
  "slack": { "repos": ["~/projects/serenity"] }
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `models` | Opus / Haiku / Sonnet | Models for the master's chat, summaries and suggestions |
| `reviewers` | none | Who to suggest for review when CODEOWNERS names nobody |
| `maxTopics` | `10` | How many topics the master groups sessions into |
| `slack.repos` | none | Repos whose maps show Slack mentions and DMs that need you ([ADR 0023](docs/adr/0023-slack-for-the-master.md), [0024](docs/adr/0024-slack-reply-suggestions.md), [0031](docs/adr/0031-slack-joins-needs-you.md), [0034](docs/adr/0034-dismiss-slack-items.md)); run `serenity slack login` once |

State (SQLite, socket, daemon log) lives in `~/.local/state/serenity`. Set `SERENITY_HOME` to use another directory.

## Development

serenity is TypeScript on [Bun](https://bun.sh) with an [Ink](https://github.com/vadimdemedes/ink) TUI, split into `packages/core`, `daemon`, `tui` and `cli`.

```bash
bun install
bun dev              # run from source with its own state and tmux server
bun run install:local  # build and install to ~/.local/bin for daily use
```

| Command | What it does |
|---------|--------------|
| `bun run test` | Unit and contract tests |
| `bun run test:e2e` | End-to-end in a private tmux server with a fake `claude` |
| `bun run lint` / `bun run format` | Biome |
| `bun run typecheck` | TypeScript |
| `bun run build` | Single binary at `dist/serenity` |
| `bun run install:local` | Build, install to `~/.local/bin/serenity`, restart the daemon |
| `bun dev …` | The CLI from source, isolated state and tmux server |

A new build replaces a running daemon by itself.

**Further reading:** [decision records](docs/adr/README.md) · [screen specs](docs/design/handover.md) · [dogfooding notes](docs/dogfooding.md) · [website source](website/) · [changelog](CHANGELOG.md)

**Releases:** merging the release-please PR on `main` tags a version; the release workflow attaches the binaries and bumps the Homebrew tap ([ADR 0025](docs/adr/0025-install-script-and-homebrew.md)).

## License

[MIT](LICENSE). serenity is an independent open-source project, not affiliated with or endorsed by Anthropic, Slack or Microsoft.
