# 0033 · The master starts sessions from a brief

**Status:** Accepted · 2026-10-28

## Context
Starting work means pressing `N`, typing a name and a first prompt per session, and then telling the master about them. A brief that splits into several sessions is exactly what the Opus chat is good at, and the sessions it would start belong in its view anyway.

## Decision
- A serenity MCP tool, **`create_session`** (`name`, `prompt`, optional `topic`), runs the daemon's `session.create` as `N` does: a new worktree beside the repo, on a new branch off the default base named after the session, with `prompt` as the agent's first message.
- It **acts at once** and is pre-allowed, like `set_topic` and `archive_session` (0008): the user asking for the work is the approval. The skill tells the chat to create only on such a request, to say how it would split an unclear brief and wait for a go, and to write each prompt self-contained, since the new agent sees nothing of the chat.
- Only worktree mode: the chat never checks out an existing branch. Names and branches that clash fail with the same errors as `N`.
- `topic` is checked against the topic cap as `set_topic` is; left out, the summarizer picks one.
- Nothing extra is stored to put the session "in the master's context": it is a session like any other, so it appears in the snapshot sent with every chat message.

## Consequences
- What the new agent may do is governed by the user's own Claude Code permissions, as for any session started with `N`; the master gains no write access of its own.
- A chat can start many sessions in one turn; each is a worktree and a running agent the user cleans up as usual.
