# 0030 · The master's skill, auto mode, and Slack messages sent once confirmed in the chat

**Status:** Accepted · 2026-10-28

## Context
The Opus chat learns serenity's tools from a few system-prompt lines (0008), which say little about when each one fits. Anything outside its pre-allowed read-only set stops at "◆ master wants to use …" in NEEDS YOU, including harmless reads the allow-list doesn't spell out. And sending a Slack message (0023) means drafting it in the chat, the user agreeing there, and then pressing `y` on the same text again.

## Decision
- **A skill.** `packages/daemon/src/master-skill.md` is bundled into the binary. On start the daemon writes it as the plugin `<home>/master-plugin` (`serenity-master`, skill `serenity`), and the chat loads it with `--plugin-dir`; `--setting-sources ""` loads no other skills. The chat gets the `Skill` tool with only `Skill(serenity-master:serenity)` pre-allowed, and its system prompt says to load the skill before its first serenity or Slack tool call. The skill maps requests to tools, says `suggest` runs nothing until `y`, and gives the Slack draft-confirm-send steps.
- **Auto mode.** The chat runs with `--permission-mode auto`: Claude Code's classifier approves or blocks what the allow-list doesn't cover. `--tools` still limits it to `Read,Grep,Glob,Bash,Skill`, and `--permission-prompt-tool` stays for what reaches a prompt.
- **Slack messages, confirmed in the chat.** `--settings` adds an `ask` rule for `mcp__slack__slack_send_message`, so a send always reaches `request_permission`, never the classifier. There serenity allows it without asking when the user's latest message answers a master reply that showed the message's text (quote markers and whitespace aside): `confirmedSlackSend`. Otherwise it waits for `y`/`n` as before. Reactions and other Slack writes are unchanged.

## Consequences
- The send check proves the user saw the exact text and replied; whether the reply was a yes is the model's reading, as the skill instructs. A Slack message or session output cannot get unseen text sent.
- What auto mode lets through depends on Claude Code's classifier, not on serenity.
- Editing the skill means editing the markdown file; the daemon rewrites the plugin on every start.
