# 0007 · Master = Opus stream + Haiku/Sonnet one-shot workers via the claude CLI

**Status:** Accepted · 2026-10-25

## Context
The master chats with the user, writes card summaries, judges finished vs idle, proposes actions, and assigns categories. Different jobs warrant different models. Using the `claude` CLI headless reuses the user's existing Claude Code login and subscription; no API key is needed.

## Decision
Three roles, all run through `claude -p`:

| Role | Model | Process | Jobs |
|------|-------|---------|------|
| Chat | Opus | One long-lived process per repo: `--input-format stream-json --output-format stream-json` | Conversation with the user, category assignment, cross-session reasoning |
| Summarizer | Haiku | One-shot per event, `--json-schema` structured output | ≤2-sentence summary, one-line "asks", finished vs idle after `Stop` |
| Suggester | Sonnet | One-shot per event, `--json-schema` structured output | One suggestion per session: reply / approve / cleanup / review |

- The daemon feeds the chat stream compact event digests and the user's messages; it does not stream raw transcripts.
- Workers are queued and debounced per session, so a burst of hooks yields one call.
- Model IDs are aliases in config (`opus`, `sonnet`, `haiku`) so users can override them.
- The chat process is restarted with `--resume` after a crash or daemon restart.

## Consequences
- Cost scales with event volume; the debounce window and a per-repo concurrency limit are config values.
- Depends on `claude` CLI flags (`--input-format`, `--output-format`, `--json-schema`, `--mcp-config`, `--permission-prompt-tool`, `--resume`, `--model`); the doctor check verifies the CLI version.
