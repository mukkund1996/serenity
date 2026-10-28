# serenity

A keyboard-only terminal app that shows every Claude Code session as a node on a mind map around one master agent. Only what needs you asks for attention.

Status: milestone 4 (map and navigation). Sessions with live status from hooks, the topics zoom, attach / `Ctrl+g` back, and the master: Haiku summaries and topics, Sonnet suggestions you approve with `y`, cleanup with git safety checks, and an Opus chat (`g`). PRs (milestone 3): each card shows its PR and checks from `gh`, `o` opens it, ready PRs get a review request from CODEOWNERS, and a merged PR finishes the session. Claude sessions you already run in tmux can be imported with `I` (they stay in their windows). Map and navigation (milestone 4): `z` zooms out to the map, with the master in the centre and topics around it (the arrow keys move between topics there); `Z` zooms back in to topics, and on a card in topics on into its session; `Esc` zooms out. The arrow keys and WASD move between nodes. Enter on a card attaches it and `i` sends it a quick message; Enter on the master goes into it (`↑` `↓` select inside it, Enter acts) and `Esc` leaves it. `Ctrl+m` focuses the master from any view, a session included (it needs a terminal that sends extended keys; in Apple Terminal it is Enter). `c` centres on the master, `/` searches sessions, and `r` renames one. `p` pins a session you reuse: it moves to the `pinned` topic, is never marked finished or offered a cleanup, and resumes with `claude --resume` when you attach after it ended.

- Website: [getserenity.dev](https://getserenity.dev) (source in [`website/`](website/), [0029](docs/adr/0029-website-on-github-pages.md))
- Decisions: [`docs/adr/`](docs/adr/README.md)
- Using it daily while developing it: [`docs/dogfooding.md`](docs/dogfooding.md)
- Screen specs: [`docs/design/handover.md`](docs/design/handover.md)

## Install

macOS or Linux. One command installs serenity and what it needs: [tmux](https://github.com/tmux/tmux) 3.2+, git, [`gh`](https://cli.github.com) and [Claude Code](https://claude.com/claude-code), skipping any you already have:

```bash
curl -fsSL https://raw.githubusercontent.com/mukkund1996/serenity/main/scripts/install.sh | sh
```

Or with Homebrew (tmux, git and gh come as dependencies; Claude Code is a cask):

```bash
brew install --cask claude-code; brew install mukkund1996/tap/serenity
```

Then `gh auth login` for PR status (optional: without it cards say why), and run `serenity` inside any git repo. `serenity doctor` checks the setup. The installer takes `SERENITY_VERSION`, `SERENITY_INSTALL_DIR` (default `~/.local/bin`) and `SERENITY_NO_DEPS=1`.

Releases: merging the release-please PR on `main` tags a version; the release workflow attaches the binaries and bumps the tap ([0025](docs/adr/0025-install-script-and-homebrew.md)).

## Development

```bash
bun install
```

Install it for daily use, then run `serenity` inside any git repo (it opens the map for that repo):

```bash
bun run install:local
```

`bun dev` runs the source with its own state and tmux server, apart from your daily one.

| Command | What it does |
|---------|--------------|
| `bun run test` | unit and contract tests |
| `bun run test:e2e` | end-to-end in a private tmux server with a fake `claude` |
| `bun run lint` / `bun run format` | Biome |
| `bun run typecheck` | TypeScript |
| `bun run build` | single binary at `dist/serenity` |
| `bun run install:local` | build, install to `~/.local/bin/serenity`, restart the daemon |
| `bun dev …` | the CLI from source, isolated state and tmux server |

State (SQLite, socket, daemon log) lives in `~/.local/state/serenity`; set `SERENITY_HOME` to use another directory. `serenity restart` restarts the background daemon and `serenity stop` stops it; a new build replaces a running daemon by itself.

The master runs on your own Claude Code login. Models default to Opus (chat), Haiku (summaries) and Sonnet (suggestions); override them in `~/.config/serenity/config.json`. `reviewers` is who to suggest for review when CODEOWNERS names nobody. `maxTopics` caps how many topics the master groups sessions into (default 10). `slack.repos` turns on Slack for those repos' maps ([ADR 0023](docs/adr/0023-slack-for-the-master.md)): the mentions and DMs that need you to act (at most three) join NEEDS YOU ([ADR 0030](docs/adr/0030-slack-joins-needs-you.md)), and the master's chat can read Slack. The master suggests a reply from your sessions and PRs, or asks a session first ([ADR 0024](docs/adr/0024-slack-reply-suggestions.md)); `y` posts it in the thread, `e` edits, `n` declines. Run `serenity slack login` once to sign in.

```json
{
  "models": { "chat": "opus", "summarizer": "haiku", "suggester": "sonnet" },
  "reviewers": ["teammate-login"],
  "maxTopics": 10,
  "slack": { "repos": ["~/projects/serenity"] }
}
```

## License

[MIT](LICENSE)
