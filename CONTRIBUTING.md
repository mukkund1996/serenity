# Contributing to serenity

Thanks for helping out. This page covers how the repo works and what a pull request needs. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md); report a violation privately as it describes.

## Questions, ideas and bugs

- **Questions and ideas:** start a thread in [GitHub Discussions](https://github.com/mukkund1996/serenity/discussions).
- **Bugs and feature requests:** open an [issue](https://github.com/mukkund1996/serenity/issues/new/choose) from its form. For a bug, give what you did, what you expected, and `serenity version`. The daemon log (`~/.local/state/serenity/daemon.log`) and `serenity doctor` output usually help.
- **Security problems:** don't open an issue. Report them privately as [SECURITY.md](SECURITY.md) describes.
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
- **CI must be green** before merge, on macOS and Ubuntu. A maintainer squash-merges once it is (never with auto-merge).
- **Update the docs** that your change makes wrong: the README (keys, config, commands) and any ADR it amends.

## Maintainers

### Releases and the guardrails around them

How a change reaches users (ADR 0068):

1. A PR is squash-merged into `main`. `ci` runs on the push, on Ubuntu and macOS.
2. **Only if that ci run passes, and its commit is still `main`'s head**, the `release` workflow goes on. Its `gate` job (`scripts/release-gate.sh`) checks this. Otherwise it stops with a notice, and nothing is tagged, built or bumped. A red `main` never ships.
3. release-please opens or updates the release PR (`chore(main): release X.Y.Z`). It pushes with `GITHUB_TOKEN`, which fires no `pull_request` event, so the release workflow dispatches `ci` on the PR's branch. Its checks show on the PR like any other's.
4. Merging the release PR goes through steps 1 and 2 again. Then release-please tags `vX.Y.Z` and creates the GitHub release, and the `build` and `publish` jobs attach the binaries and `SHA256SUMS` and bump the Homebrew tap.
5. `publish` then dispatches `install-smoke` for the new tag (installing from the release run's mirrored artifacts, so download counts stay clean, ADR 0056) and `website` (the page shows the new version). Check that both pass.

Guardrails:

- **A red `main` opens an issue.** `main-health` opens one issue labelled `main-red` (or comments on the open one) and comments on the PR the failing commit came from. The next green run closes it. Fix `main` first: releases wait for it.
- **Flaky e2e files are retried once and named.** `bun run test:e2e:ci` reruns a failing e2e file once. If it then passes, the job stays green but shows a `FLAKY` warning and a row in the job summary. Treat that as a bug in the test. Unit tests (`bun run test`) are never retried.
- **Duplicate ADR numbers fail ci** (`bun run check:adr`). Two PRs in flight often take the same next number; rebase on `main` and renumber yours.
- **Rebuilding a release's binaries:** run the `release` workflow by hand with the tag. It refuses a tag whose commit has no passing ci run on `main`.
- **Checking the gate by hand,** for any ci run:

  ```bash
  eval $(gh run view <ci-run-id> --json event,conclusion,headSha --jq '"EVENT=\(.event) CONCLUSION=\(.conclusion) SHA=\(.headSha)"')
  EVENT=$EVENT CONCLUSION=$CONCLUSION SHA=$SHA scripts/release-gate.sh   # go=true or go=false, and why
  ```

- `release.yml` and `main-health.yml` run on `workflow_run`, which always uses the copy on `main`. Changes to them take effect only after they merge.

### Leaving your own visits out of the website analytics

getserenity.dev counts page views and a few events (copy, story controls, reaching the install section, star and outbound clicks) with [GoatCounter](https://www.goatcounter.com) (`website/analytics.js`). To keep your own visits out:

1. **In each browser, once:** open <https://getserenity.dev/#toggle-goatcounter>. An alert says tracking is now *disabled in this browser*. count.js then sets `localStorage.skipgc` and sends nothing from that browser: no page views and no events, on every page. Opening the same link again turns counting back on. The setting lives in that browser's storage, so do it in every browser and on every device you use, phone included. It is lost if you clear site data, and private windows don't keep it.
2. **For a fixed connection:** in the GoatCounter dashboard go to *Settings*, add your home or office IP under *Ignore IPs* and save. This covers every browser on that network, but only from then on. It stops working when your ISP changes the IP, and it does not cover a phone on mobile data, so keep using step 1 there.

Visits from `localhost`, `127.*`, LAN addresses (`192.168.*`, `10.*`, `172.16–31.*`) and `file://` are never counted. Most ad blockers block `gc.zgo.at`, so a browser with one may already send nothing. Don't rely on that, because blocker lists change.

### Reading install numbers

For every analytics source in one place (release downloads and website GoatCounter, with the scripts and caveats), see [docs/analytics.md](docs/analytics.md).

GitHub release download counts include CI, and `git clone` and traffic numbers are mostly CI checkouts: every job runs `actions/checkout`. Don't read either as adoption. Since ADR 0056, install-smoke installs from a copy and no longer adds to download counts. For an estimate of real installs per release and asset, with the older smoke runs' downloads taken out, run:

```bash
bun scripts/stats/downloads.ts
```

`SHA256SUMS` downloads are curl-installer installs. Homebrew installs fetch a binary but no `SHA256SUMS`. Release downloads you make yourself (`gh release download`, the browser) count too.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
