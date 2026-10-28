# 0023 · Slack for the master: what waits on you, read through Slack's MCP server

**Status:** Accepted · 2026-10-27 · Amended by [0030](0030-slack-joins-needs-you.md): only mentions and DMs that need an action, at most three, shown in NEEDS YOU

## Context
A lot of what waits on the user is not in a session: a teammate asks in a Slack thread whether a fix shipped, or mentions them about a PR. The answer usually sits on the map already: in a session's summary, its PR, its branch. ADR 0011 left Slack for v2.

Slack has an official MCP server (`https://mcp.slack.com/mcp`), signed in with OAuth. The user's claude.ai Slack connector cannot be used: the master's processes run with `--strict-mcp-config --setting-sources ""` (0007), and dropping that would load every MCP server and plugin the user has. A daemon-side MCP client was rejected too: the token is the `claude` CLI's, kept in its own store.

## Decision
- **Per repo, off by default.** `slack.repos` in `~/.config/serenity/config.json` lists the repos (absolute or `~/…`, resolved to real paths) whose map shows Slack. `slack.mcp` is the MCP server entry, as `--mcp-config` takes it; it defaults to Slack's server with the OAuth client of Claude Code's Slack plugin.
- **One login.** `serenity slack login` registers that entry as server `slack`, in local scope for serenity's workers folder only (so the user's own sessions never see it), and runs `claude mcp login slack`. The master's processes then pass the same entry inline with `--mcp-config` and reuse the token.
- **What waits on you:** mentions of the user, and threads the user replied in where someone else wrote after them, from the last 7 days. Anything the user answered or reacted to is left out, as are DMs (v1). At most 5, newest first, one per thread.
- **Read by a one-shot worker.** Slack is per account, so one read serves every repo with Slack on. The summarizer model runs `claude -p` with only the Slack server, `--tools ""`, and `--allowedTools` set to Slack's read tools; any other tool is denied, since `-p` has no one to ask. It returns JSON (`--json-schema`); `access: no_access` with an auth problem shows "Slack needs a login: run serenity slack login".
- **Polled, like review requests (0011):** on opening a map of such a repo (at most once a minute), then every 5 minutes while one is open (`SERENITY_SLACK_POLL_MS`). Polling stops when none is. A failed read keeps the last items and shows the error.
- **Where it shows.** Topics zoom: a SLACK section in the master panel after NEEDS YOU, before REVIEW. It shows one item: channel, author and age, then two lines of the message. It gets rows before REVIEW and shows whole or not at all. Map zoom: its own box under the master box, the same item. With nothing waiting it takes no room; an error takes one row.
- **Keys.** The item joins the master's `↑↓` elements. While it is selected, `[` `]` step through the items (`n/5` in its header) instead of between topics, and `Enter` or `o` opens the message in Slack.
- **The chat reads Slack.** In such a repo the Opus chat gets the Slack server too, with its read tools pre-allowed. Each message's snapshot lists what waits on the user. Writing to Slack (a message, a reaction) is not pre-allowed, so it goes through `request_permission`: the user sees it at the top of NEEDS YOU and presses `y` or `n` (0008).

## Consequences
- Each read is a model call with several tool calls: about one Haiku call per 5 minutes while a map is open, on the user's plan.
- What counts as waiting is the model's reading of Slack search, not an exact query. Misses and false positives are possible; `[` `]` and the chat make them cheap to skip.
- The token lives in the `claude` CLI's credential store; `claude mcp logout slack` from the workers folder signs out.
- Suggested replies from session state, and asking a session before replying, build on this inbox (0024).
