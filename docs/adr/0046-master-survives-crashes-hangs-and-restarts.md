# 0046 · The master survives crashes, hangs and daemon restarts: an outbox, a watchdog, and state in SQLite

**Status:** Accepted · 2026-10-29 · Amends 0007, 0008, 0032 · revised 2026-11-05 (issue #106): the hang limit is 3 minutes, a chat's exit is never held back, and the map shows a running turn

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
- **A watchdog.** A turn with no output for 3 minutes (`CHAT_HANG_MS`; 5 until issue #106) is hung: serenity kills its process and treats it as a crash. Every stream line counts as output; the runner now emits `activity` for tool calls and their results. A turn waiting on a permission prompt or on a serenity tool is not hung.
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

## Revision · 2026-11-05 · issue #106: turns that never ended
Users saw the master work forever, or stop with no reply. The causes found, and what changed:
- **A chat's exit could be held back for up to 15 minutes.** The `exit` event waited for claude's stderr to close, and a child that outlives claude keeps it open: its MCP server waiting on a permission request (the proxy's 15-minute timeout), or a Bash command left running. Until then the dead turn stayed thinking, its permission request stayed in NEEDS YOU, and a message written to it was lost, since writing to an exited process does not fail. Now the exit is reported once stdout is read or after 1 s (`EXIT_DRAIN_MS`), whichever is first, so a result printed just before it still comes first, and `send` to an exited process throws, which pump already treats as a crash.
- **A permission request left over from an ended turn** kept the watchdog re-arming through the next turn. A `result` now denies the repo's pending requests, as an exit does.
- **An error while handling a line of output** (saving the reply, sending the next message) stopped the chat's output being read and left the turn thinking. Each line is now handled on its own, and a failure ends the chat as a crash: it is restarted and the message sent again.
- **A turn that answered the user with no text** looked like no answer yet. It now shows `master finished without a reply; ask again`. Turns of serenity's own (a watch fired) may end silently.
- **An error result without text** (`error_max_turns`, `error_during_execution`) showed as `master: `. It now shows its `errors` or its kind.
- **After the third failed restart**, messages queued behind the dropped one waited unseen; the error now says how many wait for the next message.

The hang limit is now **3 minutes**. Every stream line counts as output, serenity's tools answer within 2 minutes, and a turn waiting on the user is exempt, so 3 minutes of silence is only a model call or a read-only Bash command that has stalled. A false hang costs a restart and a re-sent message; a real one cost 5 minutes of a frozen chat.

**The map shows a running turn.** `MasterState.turn` carries when it started, its last output, and whether it waits on the user or a serenity tool. The master's header shows `working 1m05s`, adds `· quiet 40s` after 30 s without output, and shows `waiting on you 2m10s` while a permission request is pending, so a long turn and a hung one look different.

**The daemon logs each turn**: its start (whose message, how many wait), each serenity tool and permission request with how long it took, the watchdog deferring for one, and how the turn ended (its length, or the process's exit with the last output and how long ago).
