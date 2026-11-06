# 0062 · The docs open after install, and a learn-serenity tutorial on first boot

**Status:** Accepted · 2026-11-05 · Amended by [0065](0065-setup-logins.md): a Setup panel for the GitHub and Slack logins opens first, and closing it focuses the tutorial; [0066](0066-welcome-panel-import-step.md) makes it the welcome panel, with an import step

## Context
In early user testing, new users installed serenity, ran it and landed on an empty map with no idea what to do next. The empty map says "Press n to start your first session". That doesn't explain the master, NEEDS YOU, attaching with `Enter` and getting back with `Ctrl+q`, or what happens to PRs. The docs page explains all of it, but nothing leads people there.

We weighed three ways to teach people on first boot:
- **A static walkthrough in the TUI** (overlays and hints). It would need a new UI mode and its own state, and it would duplicate the docs.
- **The master explaining serenity in its chat.** That costs an Opus turn per question. The master's prompt is about steering sessions, not teaching, and it can't see the map either.
- **An ordinary session whose agent teaches.** It reuses everything that already exists (sessions, hooks, attach). The user learns by doing the very thing serenity is about: talking to a session on the map.

## Decision
- **The installer opens the docs.** At the end, `scripts/install.sh` prints `Docs: https://getserenity.dev/docs/` and opens that URL with `open` (macOS) or `xdg-open` (Linux). It doesn't open a browser when `SERENITY_NO_OPEN=1` is set, when `CI` is set, on Linux without `DISPLAY` or `WAYLAND_DISPLAY`, or on macOS over SSH. The URL is always printed. Homebrew doesn't run the script, so the formula's caveats name the docs and the tour instead.
- **The first map opened gets a `learn-serenity` session.** When a map subscribes (`state.subscribe`) and onboarding has never run in this serenity home, the daemon starts one session named `learn-serenity` with the first prompt `teach me how to use serenity`.
  - It runs once per serenity home (machine), not per repo. Someone who works in many repos takes the tour once.
  - A home that already has sessions (an existing user upgrading) is marked done without a tutorial.
  - The record (`onboarding` in the recovery store: when, which repo, which session, or why it was skipped) is written before the session starts, so two maps opening at once start one tutorial. The record is never cleared. Once the user archives the node (`K` or `x`), it doesn't come back, and a failed start isn't retried.
- **It runs in the repo itself, with no worktree.** The session is created like `N` with an existing branch (`mode: "branch"`, the branch the main checkout is on). That way the tour creates no branch, and archiving it leaves nothing to clean up. Its skill tells the agent to change nothing in the repo. The practice session the tour asks for is a normal one with its own worktree.
- **The tutorial is a skill, published as a plugin.** The skill lives in `plugins/learn-serenity/` and is listed in the repo's marketplace next to `parallel-sessions`. The daemon bundles the same `SKILL.md` into the binary, writes it as a plugin to `<SERENITY_HOME>/tutorial-plugin` on every start (as it does the master's, 0008), and passes `--plugin-dir` to that one session on every launch, restarts (0044) and resumes (0022) included. No other session loads it, and nothing is written to `~/.claude` or the repo. To take the tour again, install it with `/plugin install learn-serenity@serenity` and ask any session "teach me how to use serenity".
- **The skill teaches by doing.** One step per message: the map and zoom, starting a practice session with `N`, attaching with `Enter` and getting back with `Ctrl+q`, NEEDS YOU (make the practice session ask a question, then `Tab` to it and answer it), the master (`Ctrl+w`, `i`, `@` mentions), PRs, then pin, kill and clean up. Each step asks the user to try it and report back, links the matching section of the docs, and lets them skip or stop. It ends by telling them how to archive the tour.
- **It can be turned off.** Config `"onboarding": false` or `SERENITY_NO_ONBOARDING=1` skips it, and the skip is recorded like a finished tutorial. The e2e tests set the env var, except the one that tests onboarding.

## Consequences
- A new user's first map has one node to press `Enter` on, and the first thing they read is a guided tour.
- The tour is one Claude Code session on the user's own plan. It costs what any short conversation costs and nothing more.
- The tutorial's card shows the branch of the user's main checkout and that branch's PR, if it has one. Archiving the card leaves the branch alone, since the session never owned it.
- The skill can't see the map. It trusts what the user says they saw, and the wording of each step has to match the TUI. Key changes need a matching edit to `plugins/learn-serenity/skills/learn-serenity/SKILL.md`.
- A user who quits before opening the map never sees the tour. The installer and the Homebrew caveats both point to the docs.
