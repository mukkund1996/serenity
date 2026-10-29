# 0046 · The master survives crashes, hangs and daemon restarts: an outbox, a watchdog, and state in SQLite

**Status:** Accepted · 2026-10-29 · Amends 0007, 0008, 0032

## Context
The master chat (0007) is one long-lived `claude -p` per repo, and it failed in ways the user could only see as a stuck panel:
- **A hung turn never ended.** With no `result` and no exit, `thinking` stayed true, and watch messages queued behind it forever.
- **A message sent mid-turn broke the turn.** It was written to stdin at once, cleared the reply collected so far, and the first of two `result`s marked the chat idle while the second turn still ran.
- **A crash lost the message being answered.** The chat restarted only on the user's next message. Writing to a process that had died threw in the `master.message` RPC, after the message was already saved as sent.
- **A `--resume` that failed looped.** The process exited at once, the held messages restarted it, and it exited again.
- **Everything lived in memory**: the Claude session id, watches and released Slack messages (0032), and held messages. A daemon restart dropped them all.
- **A permission prompt outlived its chat**, and answering it did nothing.
- **Tools could stall a turn for 15 minutes.** A hung tmux or git call in `kill`, `create`, `reply` or `open` hit only the proxy's RPC timeout. A daemon that was briefly unreachable failed the call at once.

## Decision
- **One outbox per repo.** The user's messages and serenity's own (a watch fired) both go into it. Its first item is sent when no turn runs and no restart is pending. It leaves the outbox only when its turn's `result` arrives, so a message sent while the master is busy or down waits rather than being dropped or interleaved. The snapshot is built when a message is sent, not when it is queued.
- **A watchdog.** A turn with no output for 5 minutes (`CHAT_HANG_MS`) is hung: serenity kills its process and treats it as a crash. Every stream line counts as output; the runner now emits `activity` for tool calls and their results. A turn waiting on a permission prompt or on a serenity tool is not hung.
- **Restart and re-send.** If a chat dies mid-turn (it exits, hangs, or its stdin is gone), it is restarted with `--resume` after 1 s, 5 s, then 30 s (`CHAT_RESTART_BACKOFF_MS`), and the same message is sent again. The re-sent message starts with a note that tools it called may already have run, telling the master to check `session_status` before calling one again; the skill's "After a restart" section says the same. After the third failed restart, that message is dropped and the error says so; the rest of the outbox waits for the next message. A chat that exits idle is restarted by the next message, as before.
- **A failed resume starts fresh.** If a chat started with `--resume` exits before naming its session (init), the session id is cleared and the next start is a fresh conversation.
- **State in SQLite.** A `master` table (`MasterStore`, migration 7) keeps one record per repo: the Claude session id, watches, released Slack messages and the outbox. It is written on every change and loaded when the supervisor is constructed. When the daemon starts, `MasterSupervisor.start()` delivers any outbox left over, so a message whose turn was cut off by a daemon restart is sent again too. Pings and send-reply tracking (0039) stay in memory; they last seconds.
- **A chat that ends denies its pending permission requests**, since its MCP server has gone with it.
- **Tools answer within 2 minutes** (`TOOL_TIMEOUT_MS`). `request_permission` is exempt, as it waits for the user. A tool that times out or throws comes back to the chat as a tool error (a timeout says it may still finish), never as an RPC failure. The proxy's 15-minute timeout stays for permission requests.
- **The MCP proxy (0008) retries the daemon.** Reaching the daemon is retried after 0.25 s, 1 s and 3 s, since nothing was sent yet. A connection lost mid-call is retried only for `session_status`, because another tool may already have acted. A line that is not JSON gets a JSON-RPC parse error, `arguments` that are not an object get invalid params, and a write to a `claude` that has gone no longer takes the proxy down.

## Consequences
- A message can be answered twice. If the chat died after a tool ran but before the turn ended, the re-sent message may run that tool again. The note in the re-sent message and the skill are the only guard; there is no check in serenity. `create_session` and `send_reply` are the tools where that matters.
- While the master is busy, "thinking" also covers a pending restart. The error line shows `restarting (n/3)` until a turn succeeds.
- Snapshot size and the TUI's view of a down or queued master are not part of this ADR.
