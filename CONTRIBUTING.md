# Contributing to serenity

Thanks for helping out. This page covers how the repo works and what a pull request needs.

## Questions, ideas and bugs

- **Questions and ideas:** start a thread in [GitHub Discussions](https://github.com/mukkund1996/serenity/discussions).
- **Bugs:** open an [issue](https://github.com/mukkund1996/serenity/issues) with what you did, what you expected, and `serenity version`. The daemon log (`~/.local/state/serenity/daemon.log`) and `serenity doctor` output usually help.
- **Larger changes:** discuss them first, so the design can be agreed before you write the code.

## Setup

You need [Bun](https://bun.sh) 1.4.4 (the version CI uses), tmux, git and `gh`. Claude Code is only needed to run serenity for real; the tests use a fake `claude`.

```bash
bun install
bun dev        # run from source, with its own state dir and tmux server
```

`bun dev` keeps its state in `~/.local/state/serenity-dev` and uses a private tmux server (`tmux -L serenity-dev`), so it never touches your everyday install. [docs/dogfooding.md](docs/dogfooding.md) explains how to use serenity daily while you work on it, with `bun run install:local`.

## Layout

| Path | What lives there |
|------|------------------|
| `packages/core` | Domain types, the RPC schema, status and attention logic, the storage interface |
| `packages/daemon` | The daemon: tmux sessions, hooks, the master and its MCP tools, `gh`, Slack, SQLite |
| `packages/tui` | The Ink TUI and the map |
| `packages/cli` | The `serenity` command (entry point `src/main.ts`) |
| `e2e/` | End-to-end tests in a throwaway tmux server, with a fake `claude` and `gh` |
| `docs/adr/` | Architecture decision records |
| `docs/design/` | Screen specs |
| `scripts/` | Build, local install, the curl installer, the Homebrew formula |
| `website/` | getserenity.dev |

Each package keeps its tests in `test/`.

## Checks

CI (`.github/workflows/ci.yml`) runs these on Ubuntu and macOS for every pull request. Run them before you push:

```bash
bun run lint        # Biome; `bun run format` fixes formatting and import order
bun run typecheck
bun run test        # unit and contract tests in packages/
bun run test:e2e    # needs tmux; SERENITY_E2E_KEEP=1 keeps the temp dir for debugging
bun run build && ./dist/serenity version
```

Biome uses tabs and double quotes (see `biome.json`). Markdown is not linted.

Tests never call the real Claude ([ADR 0013](docs/adr/0013-testing-strategy.md)). Behaviour you can see on screen or in tmux needs an E2E test in `e2e/`. Logic needs a unit test beside the package's code.

## Decisions (ADRs)

New features and changes to existing behaviour get an ADR in [`docs/adr/`](docs/adr/README.md):

1. Take the next number. The highest is in the index in `docs/adr/README.md`. Name the file `NNNN-short-slug.md`.
2. Follow the shape of recent ADRs: a `# NNNN · Title` heading, a `**Status:** Accepted · YYYY-MM-DD` line, then **Context**, **Decision** and **Consequences**.
3. Add a row to the index in `docs/adr/README.md`.
4. If the ADR changes an earlier one, say so in its status line (`Amends 0026`). Set the earlier one's status in the index to `Amended by NNNN` or `Superseded by NNNN`. Do not rewrite the earlier ADR.

Bug fixes that restore intended behaviour don't need an ADR. Where an ADR and the screen specs disagree, the ADR wins.

## Pull requests

- **One change per PR,** branched from `main`.
- **The PR title is a [conventional commit](https://www.conventionalcommits.org/)** (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`). PRs are squash-merged, so the title becomes the commit on `main`. Add the ADR number when there is one, e.g. `feat: @new starts sessions from a brief at once (ADR 0048)`.
- **Releases come from those titles.** [release-please](release-please-config.json) turns `feat:` and `fix:` commits into the next version and its [CHANGELOG.md](CHANGELOG.md) entry. Don't edit the changelog or version numbers by hand.
- **CI must be green** before merge. A maintainer squash-merges once it is.
- **Update the docs** that your change makes wrong: the README (keys, config, commands) and any ADR it amends.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
