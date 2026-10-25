# serenity

A keyboard-only terminal app that shows every Claude Code session as a node on a mind map around one master agent. Only what needs you asks for attention.

Status: milestone 3 (PRs). Sessions with live status from hooks, the topics zoom, attach / `Ctrl+g` back, and the master: Haiku summaries and categories, Sonnet suggestions you approve with `y`, cleanup with git safety checks, and an Opus chat (`g`). PRs (milestone 3): each card shows its PR and checks from `gh`, `o` opens it, ready PRs get a review request from CODEOWNERS, and a merged PR finishes the session. Claude sessions you already run in tmux can be imported with `I` (they stay in their windows).

- Decisions: [`docs/adr/`](docs/adr/README.md)
- Using it daily while developing it: [`docs/dogfooding.md`](docs/dogfooding.md)
- Screen specs: [`docs/design/handover.md`](docs/design/handover.md)

## Requirements

macOS or Linux, [tmux](https://github.com/tmux/tmux) 3.2+, [Claude Code](https://claude.com/claude-code), git. [`gh`](https://cli.github.com), logged in, for PR status (optional: without it cards say why).

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

The master runs on your own Claude Code login. Models default to Opus (chat), Haiku (summaries) and Sonnet (suggestions); override them in `~/.config/serenity/config.json`. `reviewers` is who to suggest for review when CODEOWNERS names nobody:

```json
{
  "models": { "chat": "opus", "summarizer": "haiku", "suggester": "sonnet" },
  "reviewers": ["teammate-login"]
}
```

## License

[MIT](LICENSE)
