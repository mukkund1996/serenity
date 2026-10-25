# 0002 · TypeScript + Ink on Bun, shipped as a compiled binary

**Status:** Accepted · 2026-10-25

## Context
Options were Go + Bubble Tea, TypeScript + Ink, and Rust + Ratatui. The master talks to Claude through the `claude` CLI (0007), so no language needs an Agent SDK. A public tool installed via Homebrew and `curl | sh` should not require users to install a runtime.

## Decision
- **Language:** TypeScript (strict).
- **TUI:** Ink (React).
- **Runtime:** Bun. Release artifacts are `bun build --compile` single binaries per OS/arch.
- **Repo layout:** Bun workspace monorepo — `packages/core`, `packages/daemon`, `packages/tui`, `packages/cli`.
- **Lint/format:** Biome.
- **Tests:** `bun test` (0013).

## Consequences
- Bun built-ins (`bun:sqlite`, `Bun.spawn`, unix sockets) cover most needs with no native addons, which keeps `--compile` simple. Avoid dependencies that need node-gyp.
- Ink's flexbox model is weak at free positioning; handled by 0003.
- `core` holds pure logic and shared types (RPC schema, domain model) with no I/O, so it is easy to test.
