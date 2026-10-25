# 0014 · Distribution, release, licence, telemetry

**Status:** Accepted · 2026-10-25

## Decision
- **Binaries:** `bun build --compile` for darwin-arm64, darwin-x64, linux-x64, linux-arm64, attached to GitHub Releases.
- **Install:** Homebrew tap (`mukkund1996/homebrew-tap`) and a `curl | sh` installer that picks the right binary and verifies its checksum.
- **Versioning:** conventional commits + release-please → changelog, tag, release; the release workflow builds binaries and bumps the tap formula.
- **Licence:** MIT.
- **Telemetry:** none. Nothing leaves the machine except the user's own `claude` and `gh` calls.
- **Spawned sessions** use the user's own Claude Code permission settings; serenity only adds its hooks.

## Consequences
- The repo is private for now; the tap and installer need it public (or a public release mirror) before launch.
