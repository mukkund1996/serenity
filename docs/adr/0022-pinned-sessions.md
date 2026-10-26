# 0022 · Pinned sessions

**Status:** Accepted · 2026-10-26

## Context
Some sessions are not tasks but tools you come back to: a long-lived helper, a scratch agent, a reviewer. The lifecycle built for tasks works against them. The summarizer marks them done when a turn ends, a merged PR finishes them, Sonnet proposes cleaning them up, and once their claude exits they sit as dead in NEEDS YOU.

## Decision
- **`p` pins or unpins the focused session.** Only the user pins. The master has no pin tool, and `set_topic` will not move a session into or out of the pinned topic.
- **Pinned sessions are drawn under a topic called `pinned`.** It is listed first, so it has a fixed place: top left in the topics zoom, and the first bubble on the map. It shows only while it holds a session. The session keeps its own topic underneath, and goes back to it when unpinned. The summarizer does not change that topic while the session is pinned. `pinned` is reserved: the summarizer and `set_topic` cannot use it, and pinned sessions do not count toward `maxTopics` (0019).
- **A pinned session is never done.** A finished turn leaves it idle, and a merged PR shows on its card but does not finish it. Pinning a done session makes it idle and drops its pending cleanup suggestion. Sonnet never suggests a cleanup for it, and the chat's `suggest` refuses one. Replies, approvals and review requests work as before.
- **An ended pinned session resumes on attach.** When its claude exits, the card says "Ended. Enter resumes it." and it stays out of NEEDS YOU. Attaching opens a new window in its working directory with `claude --resume <id>` under serenity's hooks, or a fresh `claude` if it never started. An imported session comes back as one serenity spawned. While it is ended, it keeps its name, so no new session can take it.
- **Closing stays explicit.** `K` kills and archives a pinned session, and `x` cleans it up, both after a confirm. In the archived list it sits under `pinned`.

## Consequences
- `Session` gains `pinned` (false for rows written before; storage fills it in).
- A pinned session's branch and worktree stay as they are after its PR merges. Starting the next task on a new branch is up to the user.
