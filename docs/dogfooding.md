# Dogfooding

Use serenity for your daily Claude Code sessions while you keep building it. Two copies stay apart so hacking on one never disturbs the other:

| | everyday | dev |
|---|---|---|
| binary | `~/.local/bin/serenity` (compiled) | `bun dev` (from source) |
| state | `~/.local/state/serenity` | `~/.local/state/serenity-dev` |
| tmux | your normal tmux server | a private server, `tmux -L serenity-dev` |
| sees | your real sessions | only sessions it starts |

## Day one

```bash
cd ~/projects/serenity && bun install && bun run install:local
```

Then, in the repo you work in, open a tmux window and run `serenity`. Press `I` to import the Claude sessions already running in your tmux windows for that repo, then Enter. They stay where they are; Enter on a card jumps to its window and `Ctrl+g` brings you back. `U` restarts an imported session (when idle) under serenity's hooks for full status. New sessions (`n`) go through serenity as usual.

## The loop

1. **Notice something** while using it: a wrong status, a bad suggestion, an awkward key.
2. **Capture it** in one line so you keep working (create the label once with `gh label create dogfood -R mukkund1996/serenity`):

   ```bash
   gh issue create -R mukkund1996/serenity -l dogfood -t "…" -b ""
   ```

3. **Fix it** in this repo. A serenity session on the serenity repo works well: `cd ~/projects/serenity && serenity`, then `n`.
4. **Check it** with `bun run test`, `bun run test:e2e`, and `bun dev` for anything you want to see on screen.
5. **Ship it to yourself:** `bun run install:local`. It builds, swaps the binary atomically and restarts the daemon. Running sessions keep running; their hooks call the new binary straight away.

## Why upgrades are safe

- Every build has its own id (`serenity version`, e.g. `0.4.0+3f2a9c1.1025-1650`). A client that finds a daemon of another build asks it to stop and starts its own, so you can't end up on stale code.
- Hooks start the daemon if it is down, so a restart loses no events.
- State lives in SQLite; the daemon rebuilds everything from it. Imported sessions are re-read from Claude's own files on start.
- The master chat does not survive a restart (it starts again on your next `g` message); summaries and suggestions do.

## When something looks wrong

- `~/.local/state/serenity/daemon.log` has what the daemon did and why it failed.
- `serenity doctor` checks tmux, claude, git and gh.
- `serenity restart` restarts the daemon; `serenity stop` stops it.
- `SERENITY_E2E_KEEP=1 bun run test:e2e` keeps the test's temp dir (daemon log, database) to look at.
