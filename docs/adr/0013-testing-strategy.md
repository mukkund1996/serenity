# 0013 · Testing strategy

**Status:** Accepted · 2026-10-25

## Decision
- **Runner:** `bun test`.
- **No real Claude in tests.** A **fake `claude` binary** replays recorded stream-json for master roles and fires scripted hook events for sessions. Recordings live in `test/fixtures/`.
- **Layers:**
  - **Unit** — core logic: status reducer, attention ranking, topic selection, layout engine and link routing, suggestion executors, storage via the in-memory backend.
  - **Contract** — the JSON-RPC schema, and the storage interface suite run against every backend (0009).
  - **E2E in real tmux** — start daemon + TUI in a throwaway tmux server with the fake `claude`, drive keys with `send-keys`, assert on `capture-pane` output.
- TUI frame snapshot tests are not a separate layer for now.
- **CI:** GitHub Actions on macOS and Linux runs Biome, typecheck, unit, contract and E2E on every push to `main`.
