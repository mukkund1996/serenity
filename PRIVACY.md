# Privacy

serenity runs on your machine, as your user. It has no servers of its own and no account system, and the app collects no telemetry or analytics. The project never receives your data. serenity only talks to the services you already use: Claude Code, GitHub through `gh`, and Slack if you turn it on. Each one gets only what it needs.

This is a plain-language note about what the code does. It is not legal advice. The decision records in [docs/adr](docs/adr/README.md) have the details.

## What is sent, and where

**Claude (Anthropic), through your own Claude Code login.** The master agent runs the `claude` CLI you are signed in to, so the usage terms of your Claude account apply ([ADR 0007](docs/adr/0007-master-roles-and-models.md)):

- **Summaries** (Haiku by default): a session's name and branch, your last prompt to it, its last reply, and the existing topic names.
- **Suggestions** (Sonnet): the same session details, plus its pull request and the review requests waiting on you.
- **The master chat** (Opus): what you type to it, plus a snapshot of every session in the repo (status, summary, question, pending suggestion), and your Slack inbox when Slack is on.
- **Slack** (when on): the model reads your Slack messages through Slack's tools, so their text goes to Claude. Slack suggestions also get the session details above.

You can change the models with `models` in `~/.config/serenity/config.json`.

**GitHub, through your `gh` login.** serenity reads your GitHub login, the pull request of each session's branch, the PRs waiting for your review, and the repo's CODEOWNERS file ([ADR 0011](docs/adr/0011-pr-status-via-gh.md)). It writes only two things. One is a reviewer you asked for, added when you press `y` on that suggestion. The other is a crash report, and only if you turn on `crashReports.enabled` (off by default). Crash reports are public issues on `mukkund1996/serenity`, with tokens, emails and paths removed first ([ADR 0045](docs/adr/0045-daemon-supervisor-crash-reports-recovery.md)). Every report is also saved in `crash-reports/` in the state directory, so you can see what would be sent.

**Slack, only if you turn it on.** Slack is off until you connect it (the Setup panel on first boot, `Ctrl+,` → Slack, or `serenity setup slack`) and turn it on for a repo ([ADR 0023](docs/adr/0023-slack-for-the-master.md)).

- **What it reads:** your own profile, messages from the last 7 days that @-mention you by name, your DMs and group DMs, the threads around them, people's names, and reactions. It uses read-only tools. It checks once a minute, and only while a map of a repo with Slack on is open.
- **What it shows:** at most three messages that still need you to act ([ADR 0031](docs/adr/0031-slack-joins-needs-you.md)).
- **What it writes:** nothing unless you approve it. A reply goes out when you press `y` on it in NEEDS YOU, or when you confirm the exact text in the master chat ([ADR 0024](docs/adr/0024-slack-reply-suggestions.md), [ADR 0030](docs/adr/0030-master-skill-auto-mode-confirmed-slack.md)). Any other Slack write by the chat asks you first. A handover doc is shared as a file only after you confirm the file, the channel and the comment. The file's bytes go straight to Slack's upload URL, not through a model ([ADR 0049](docs/adr/0049-copy-and-handover-docs.md)).

## What is stored on your machine

The state directory is `~/.local/state/serenity`. If they are set, `$XDG_STATE_HOME/serenity` or `$SERENITY_HOME` is used instead. Only you can read it: serenity makes the folder `0700` and the files below `0600`. It holds:

- `serenity.db` (SQLite): your sessions and their summaries, prompts and last replies, the master chat conversation, suggestions, and how long sessions waited on you. For Slack it keeps only the messages you dismissed, as a channel ID and timestamp ([ADR 0034](docs/adr/0034-dismiss-slack-items.md)). The Slack inbox and Slack suggestions stay in memory.
- `daemon.log`, `crash-reports/`, and `handovers/` (handover docs copied out of session worktrees).
- Files serenity writes for Claude Code: `claude-hooks.json`, `master-plugin/`, and the `workers/` folder where one-shot model calls run.

The config is in `~/.config/serenity/config.json` (or under `$XDG_CONFIG_HOME`). It holds no secrets.

Claude Code keeps its own copy of the master chat, as it does for any session, under `~/.claude/projects/`. So do the sessions you start. The one-shot workers keep no history (`--no-session-persistence`).

## Tokens

serenity stores no tokens. GitHub access is `gh`'s login: the Setup panel runs `gh auth login` for you and reads back only whether you're logged in and as whom ([ADR 0065](docs/adr/0065-setup-logins.md)). The Slack OAuth token comes from `claude mcp login` (which the Setup panel and `serenity setup slack` run), so Claude Code stores it, as it does its own login: in the macOS Keychain on macOS, and in a file in `~/.claude` that only you can read on Linux. serenity never reads the token, and it never writes one to its database, log or crash reports.

## Disconnect Slack and delete your data

Turn Slack off: run `serenity slack off` in each repo (or `Ctrl+,` → Slack on its map). `serenity slack status` tells you whether it is on. It applies at once; by hand, remove the repos from `slack.repos` in `~/.config/serenity/config.json`.

Sign out and remove the Slack server serenity registered:

```bash
cd ~/.local/state/serenity/workers   # or <your state dir>/workers
claude mcp logout slack
claude mcp remove -s local slack
```

To revoke access on Slack's side too, remove the app from your workspace's **Apps → Manage** page in Slack.

Delete everything serenity stores:

```bash
serenity stop
rm -rf ~/.local/state/serenity       # or $XDG_STATE_HOME/serenity, or $SERENITY_HOME
rm -rf ~/.config/serenity
```

Session worktrees sit beside your repo ([ADR 0010](docs/adr/0010-worktrees-beside-repo.md)). They are your code, so remove them with `git worktree remove` as usual. Claude Code's own history under `~/.claude/projects/` is Claude Code's to manage.

## The website

[getserenity.dev](https://getserenity.dev) counts visits with [GoatCounter](https://www.goatcounter.com). It sets no cookies and builds no profile of you. It counts page views, plus a few clicks: Star on GitHub, the copy buttons, the WATCH button, reaching the install section, and links off the site. The site is hosted on GitHub Pages. It loads fonts from Google Fonts, and the landing page asks GitHub's API for the star count, so those services see your browser's request like any other. None of this is in the CLI.

## Questions

Ask about privacy in [GitHub Discussions](https://github.com/mukkund1996/serenity/discussions). If you have found a way serenity leaks data, report it privately as [SECURITY.md](SECURITY.md) describes, not in a public issue.
