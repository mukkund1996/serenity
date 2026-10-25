# serenity

A keyboard-only terminal app that shows every Claude Code session as a node on a mind map around one master agent. Only what needs you asks for attention.

Status: milestone 1 (walking skeleton). Sessions, live status from hooks, the topics zoom, attach / `Ctrl+g` back. The master agent comes in milestone 2.

- Decisions: [`docs/adr/`](docs/adr/README.md)
- Screen specs: [`docs/design/handover.md`](docs/design/handover.md)

## Requirements

macOS or Linux, [tmux](https://github.com/tmux/tmux) 3.2+, [Claude Code](https://claude.com/claude-code), git. `gh` is optional for now.

## Development

```bash
bun install
```

Run it from inside any git repo (it opens the map for that repo):

```bash
bun ~/projects/serenity/packages/cli/src/main.ts
```

| Command | What it does |
|---------|--------------|
| `bun run test` | unit and contract tests |
| `bun run test:e2e` | end-to-end in a private tmux server with a fake `claude` |
| `bun run lint` / `bun run format` | Biome |
| `bun run typecheck` | TypeScript |
| `bun run build` | single binary at `dist/serenity` |

State (SQLite, socket, daemon log) lives in `~/.local/state/serenity`; set `SERENITY_HOME` to use another directory. `serenity stop` stops the background daemon.

## License

[MIT](LICENSE)
