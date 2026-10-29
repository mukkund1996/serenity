# 0007 · Master = Opus stream + Haiku/Sonnet one-shot workers via the claude CLI

**Status:** Accepted · 2026-10-25 · revised 2026-10-25 (workers return JSON; Haiku assigns topics; login auth; chat on demand)

## Context
The master chats with the user, writes card summaries, judges finished vs idle, proposes actions, and assigns topics. Different jobs warrant different models.

serenity must work with the user's own Claude account login. The Claude Agent SDK was considered, since we are on TypeScript and it runs the same Claude Code engine with in-process custom tools. Its docs say that, unless previously approved, third-party products built on the SDK may not offer claude.ai login and must use API keys. So the SDK does not meet the login requirement; the `claude` CLI, already logged in on the user's machine, does.

## Decision
A **master supervisor** inside serenityd runs three roles, all through the user's own `claude` CLI (`claude -p`), using whatever login that CLI has:

| Role | Model | Process | Returns | Jobs |
|------|-------|---------|---------|------|
| Chat | Opus | Started on the user's first message, then kept running per repo: `--input-format stream-json --output-format stream-json` | Messages; MCP tool calls (0008) | Conversation with the user, cross-session reasoning, proposing actions it talks about |
| Summarizer | Haiku | One-shot per event | Structured JSON via `--json-schema`: `{ summary, ask, finished, topic }` | ≤2-sentence summary, one-line "asks", finished vs idle after `Stop`, topic |
| Suggester | Sonnet | One-shot when a session starts to need the user | Structured JSON via `--json-schema`: one suggestion or none | One suggestion per session: reply / approve / cleanup (review in milestone 3) |

- **Workers have no MCP tools.** They return JSON to the supervisor, which validates it and writes it through the storage interface.
- **Topics:** the summarizer gets the repo's existing topic names with each call and returns a topic. The supervisor applies it with a sticky rule: a session keeps its topic unless the worker returns a different one on two consecutive calls, or the session has none yet. A brand-new name is allowed when nothing fits. The Opus chat does not assign topics on its own; it only moves a session when the user asks (0008).
- **The chat runs only when the user messages it**, to save the user's plan. Each message is sent with a snapshot of every session (status, ask, summary, pending suggestion), not a running digest of events.
- The summarizer runs after each `Stop` (on the agent's last reply); the suggester when a session becomes waiting or done. Workers run with `--tools ""` and `--no-session-persistence`, so they leave nothing in the user's `--resume` list.
- Every master process runs with `--strict-mcp-config --setting-sources ""`, so the user's own hooks, plugins and MCP servers stay out; authentication still comes from their login. `--bare` is not used: it skips the subscription login.
- Workers are queued and debounced per session, so a burst of hooks yields one call.
- Model IDs are aliases in config (`opus`, `sonnet`, `haiku`) so users can override them in `~/.config/serenity/config.json` (`models.chat`, `models.summarizer`, `models.suggester`).
- If the chat process exits, the next message restarts it with `--resume` (within the same daemon run). (Amended by 0046: a turn cut off by a crash or hang is restarted and re-sent; the session id persists across daemon runs.)

## Consequences
- Cost scales with event volume and comes out of the user's own Claude plan; the debounce window and a per-repo concurrency limit are config values.
- Depends on `claude` CLI flags (`--input-format`, `--output-format`, `--json-schema`, `--mcp-config`, `--permission-prompt-tool`, `--resume`, `--model`); the doctor check verifies the CLI version.
- No in-process tools: the chat reaches serenity's MCP tools through `serenity mcp` (0008).
- **Before a public release,** confirm with Anthropic that a public tool driving the user's own logged-in `claude` CLI is acceptable, and decide whether to also offer an API-key mode.
