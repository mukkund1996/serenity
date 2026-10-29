# 0005 · Background daemon, JSON-RPC over a unix socket, scoped per repo

**Status:** Accepted · 2026-10-25 · Amended by [0043](0043-dependency-retries-and-health.md): the map reconnects with backoff, yellow then red; amended by [0044](0044-daemon-supervisor-crash-reports-recovery.md): a supervisor restarts the daemon, state is reconciled on start

## Context
`q` quits the map but sessions keep running, and the master, status pipeline and PR refresh should keep working while the map is closed. serenity is one map per repo (0001).

## Decision
- **serenityd**, one per machine, owns: session registry, status reducer, master supervisor, tmux and git drivers, `gh` calls, storage, and the MCP server.
- All state is **keyed by repo** (repo root path). Each repo gets its own master stream and topics.
- **Start:** `serenity` auto-starts the daemon if its socket is missing. No launchd/systemd service in v1.
- **IPC:** JSON-RPC 2.0 over a unix socket under `$XDG_RUNTIME_DIR` (fallback `~/.local/state/serenity`). Requests for commands; server-pushed notifications for state changes. Method and payload types live in `packages/core` and are shared by client and daemon.
- The TUI is a thin client: it renders a state snapshot plus pushed deltas and sends commands.

## Consequences
- Daemon and client must be the same build (`BUILD_ID`: version + commit + build time); the handshake asks any other build to stop and starts a fresh daemon.
- `serenity hook` and `serenity exited` start the daemon when it is down, so a restart or upgrade loses no hook events.
- Contract tests pin the RPC schema (0013).
- Crash safety: the daemon rebuilds in-memory state from storage on start and re-attaches to surviving tmux panes.
