# 0025 · Installer and Homebrew formula install the tools too

**Status:** Accepted · 2026-10-27

## Context
0014 settled on a Homebrew tap and a `curl | sh` installer for the binary. serenity is no use without tmux 3.2+, git and Claude Code, and PR status needs `gh`. A new user should get a working setup from one command, not a binary and a doctor full of red.

## Decision
- **Releases** come from release-please: conventional commits on `main` keep a release PR open; merging it tags `vX.Y.Z`, bumps `VERSION` in `packages/core/src/domain.ts`, and creates the release. `.github/workflows/release.yml` then builds `serenity-{darwin,linux}-{arm64,x64}` (darwin on macOS runners, ad-hoc signed), smoke-tests the native ones, and attaches them with `SHA256SUMS`.
- **`scripts/install.sh`** (`curl … | sh`) installs what is missing: tmux and git, then gh, through Homebrew on macOS (installing Homebrew first if needed) or the system package manager on Linux (apt, dnf, pacman, zypper, apk); Claude Code through its official installer. It never upgrades a tool that is already there, except tmux older than 3.2. Then it downloads the binary for the machine, checks it against `SHA256SUMS`, puts it in `~/.local/bin` and runs `serenity doctor`. `SERENITY_VERSION`, `SERENITY_INSTALL_DIR` and `SERENITY_NO_DEPS=1` adjust it. A failed gh install only warns; it is optional.
- **Homebrew:** `mukkund1996/homebrew-tap` holds `Formula/serenity.rb`, generated per release by `scripts/homebrew-formula.ts` and pushed by the release workflow (secret `HOMEBREW_TAP_TOKEN`). It depends on tmux, git and gh. A formula cannot depend on a cask, so Claude Code (`brew install --cask claude-code`) is in the caveats and in the README's one-liner. A formula, not a cask, so the binary isn't quarantined by Gatekeeper and Linuxbrew works.

## Consequences
- Until the repo is public (0014), release downloads need auth, so neither installer works for anyone else yet.
- Before the first release: create `mukkund1996/homebrew-tap` and add a token that can push to it as `HOMEBREW_TAP_TOKEN`. Without it the release still publishes, and the workflow warns that the tap was not bumped.
- The binaries are ad-hoc signed, not notarized. That is enough for brew and curl, which don't quarantine downloads; a browser download would need `xattr -d com.apple.quarantine`.
