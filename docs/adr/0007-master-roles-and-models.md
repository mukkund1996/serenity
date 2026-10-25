# 0007 · Master = Opus stream + Haiku/Sonnet one-shot workers via the claude CLI

**Status:** Accepted · 2026-10-25 · revised 2026-10-25 (workers return JSON; Haiku categorises; login auth)

## Context
The master chats with the user, writes card summaries, judges finished vs idle, proposes actions, and assigns categories. Different jobs warrant different models.

serenity must work with the user's own Claude account login. The Claude Agent SDK was considered, since we are on TypeScript and it runs the same Claude Code engine with in-process custom tools. Its docs say that, unless previously approved, third-party products built on the SDK may not offer claude.ai login and must use API keys. So the SDK does not meet the login requirement; the `claude` CLI, already logged in on the user's machine, does.

## Decision
A **master supervisor** inside serenityd runs three roles, all through the user's own `claude` CLI (`claude -p`), using whatever login that CLI has:

| Role | Model | Process | Returns | Jobs |
|------|-------|---------|---------|------|
| Chat | Opus | One long-lived process per repo: `--input-format stream-json --output-format stream-json` | Messages; MCP tool calls (0008) | Conversation with the user, cross-session reasoning, proposing actions it talks about |
| Summarizer | Haiku | One-shot per event | Structured JSON via `--json-schema`: `{ summary, ask, finished, category }` | ≤2-sentence summary, one-line "asks", finished vs idle after `Stop`, category |
| Suggester | Sonnet | One-shot per event | Structured JSON via `--json-schema`: one suggestion or none | One suggestion per session: reply / approve / cleanup / review |

- **Workers have no MCP tools.** They return JSON to the supervisor, which validates it and writes it through the storage interface.
- **Categories:** the summarizer gets the repo's existing category names with each call and returns a category. The supervisor applies it with a sticky rule: a session keeps its category unless the worker returns a different one on two consecutive calls, or the session has none yet. A brand-new name is allowed when nothing fits. The Opus chat does not categorise on its own; it only moves a session when the user asks (0008).
- The supervisor feeds the chat stream compact event digests and the user's messages; it does not stream raw transcripts.
- Workers are queued and debounced per session, so a burst of hooks yields one call.
- Model IDs are aliases in config (`opus`, `sonnet`, `haiku`) so users can override them.
- The chat process is restarted with `--resume` after a crash or daemon restart.

## Consequences
- Cost scales with event volume and comes out of the user's own Claude plan; the debounce window and a per-repo concurrency limit are config values.
- Depends on `claude` CLI flags (`--input-format`, `--output-format`, `--json-schema`, `--mcp-config`, `--permission-prompt-tool`, `--resume`, `--model`); the doctor check verifies the CLI version.
- No in-process tools: the chat reaches serenity's MCP tools through a separate transport (0008), which is still open.
- **Before a public release,** confirm with Anthropic that a public tool driving the user's own logged-in `claude` CLI is acceptable, and decide whether to also offer an API-key mode.
