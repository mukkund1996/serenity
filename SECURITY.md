# Security policy

## Supported versions

serenity is pre-1.0 and ships from `main` through [release-please](release-please-config.json). Only the **latest release** gets security fixes; see [CHANGELOG.md](CHANGELOG.md) or the [releases page](https://github.com/mukkund1996/serenity/releases) for which one that is. A fix lands in a new release, not as a backport. Run `serenity version` to see what you have, and update with the installer or `brew upgrade serenity`.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security problem.**

Report it privately through GitHub instead: open the [Security tab](https://github.com/mukkund1996/serenity/security) and choose **Report a vulnerability** (or go straight to [the advisory form](https://github.com/mukkund1996/serenity/security/advisories/new)). Only the maintainer sees the report.

A useful report has:

- what an attacker can do, and what they need first (a Slack message, a crafted repo, local access as another user, …)
- steps to reproduce, or a proof of concept
- `serenity version`, your OS, and `serenity doctor` output
- any log lines that help. Check them for tokens and private paths first.

## What to expect

serenity is maintained by one person in their own time, so these are targets, not guarantees:

- **Acknowledgement** within 7 days.
- **A first assessment** (whether it's a vulnerability, how serious, and a rough plan) within 14 days.
- **A fix** for serious issues as soon as one is ready, usually within 30 days; lower-severity issues go into a regular release. If a fix will take longer, I'll say so in the advisory.
- **Disclosure** through a GitHub security advisory once a fixed release is out, crediting you unless you'd rather not be named.

Please give a fix the chance to ship before you share details publicly. If you hear nothing within 14 days, add a comment to the advisory as a nudge.

## Scope

serenity runs entirely on your machine, as your user. These are the parts where a security problem would most likely live:

- **The daemon socket.** The daemon listens on a Unix socket, `serenity.sock`, in serenity's state directory (`~/.local/state/serenity`, or `$XDG_STATE_HOME/serenity`, or `$SERENITY_HOME`). The JSON-RPC on it has no authentication of its own: it relies on filesystem permissions, so anything that can connect to it can drive your sessions. A way for another local user, a web page or a remote host to reach it is in scope.
- **State on disk.** The same directory holds the SQLite database `serenity.db` (sessions, summaries, the master's conversation, Slack items you dismissed), `daemon.log`, crash reports, and the hook settings and plugin the daemon writes. Configuration is in `~/.config/serenity/config.json`, which holds no secrets.
- **Tokens.** serenity stores no tokens of its own. GitHub access goes through `gh` and its login. Slack, which is optional and off by default ([ADR 0023](docs/adr/0023-slack-for-the-master.md)), signs in with `serenity slack login`, and the OAuth token stays in the `claude` CLI's credential store; `claude mcp logout slack` from serenity's workers folder signs out. A path where serenity writes a token into its database, logs or a crash report is in scope.
- **Crash reports.** They are off until you turn on `crashReports.enabled` ([ADR 0045](docs/adr/0045-daemon-supervisor-crash-reports-recovery.md)); when on, they are filed as public GitHub issues after tokens, emails and paths are scrubbed. A secret that survives the scrubbing is in scope.
- **The master agent and untrusted text.** The master reads Slack messages, session output and PR titles, all of which other people can write. Text from those sources getting the master to send a Slack message you didn't see and confirm, start or message a session, or run a command outside its limits ([ADR 0030](docs/adr/0030-master-skill-auto-mode-confirmed-slack.md)) is in scope.
- **Commands serenity builds.** It drives tmux, git, `gh` and `claude` with arguments that include session names, branch names and briefs. Shell or argument injection through any of them is in scope.
- **Installation.** The curl installer checks release assets against `SHA256SUMS`, and the Homebrew formula pins checksums. A way around those checks is in scope.

Out of scope:

- Vulnerabilities in Claude Code, tmux, git, `gh`, Bun or Slack's MCP server. Please report those upstream. If serenity uses one of them unsafely, that is in scope.
- What Claude Code's auto-mode classifier allows or blocks for the master. That decision is Claude Code's.
- What the Claude Code sessions you start do in your repos. They run with your own Claude Code settings and permissions.
- Attacks that need code execution as your user already, or physical access to an unlocked machine.
