# 0064 · Importing past Claude Code sessions, from any repo, without tmux

**Status:** Accepted · 2026-11-05 · Amends [0016](0016-importing-running-sessions.md) (`I` lists past sessions too) and [0022](0022-pinned-sessions.md) (an imported session resumes on attach like a pinned one)

## Context
`I` (0016) imports only claudes that are running in a tmux pane on serenity's tmux server, in this repo. Most new users don't use tmux. Their Claude Code sessions run in a plain terminal or have ended, so `I` shows them nothing, and they start serenity with an empty map while weeks of conversations sit in Claude's own history.

Claude Code keeps every conversation at `<config>/projects/<cwd slug>/<session id>.jsonl` (`<config>` is `CLAUDE_CONFIG_DIR`, else `~/.claude`). `claude --resume <id>` continues one, but only from the folder it ran in, because Claude finds the transcript by that folder's slug. What we found on a real machine:
- 267 transcripts and 1.5 GB in total. The biggest is 90 MB.
- The slug can't be turned back into a path, because `/` and `-` both become `-`. The first lines of a transcript carry `cwd`, `gitBranch`, `sessionId`, `timestamp` and `entrypoint`, and the end carries the title and the last prompt.
- 133 of the 216 sessions from the last two weeks ran in folders that are gone (removed worktrees, tmp dirs).
- 27 were headless `claude -p` runs (`entrypoint: "sdk-cli"`), serenity's own workers among them.
- A claude running outside tmux writes `<config>/sessions/<pid>.json` too, just without the `tmux` field that 0016 needs.

The risk: two claudes resuming one conversation at once would interleave its transcript. serenity can't take over a terminal it didn't start.

## Decision
- **The source is Claude's history, read-only.** The daemon lists `<config>/projects/*/*.jsonl`. For each file it reads only the first 64 KB and the last 256 KB, so a 90 MB history costs no more than a small one. It caches the result per file by size and mtime. It never writes, moves or deletes anything under `<config>`. `packages/core/src/history.ts` is the one place that parses the transcript's head, as `observed.ts` is for its tail.
- **What counts as importable:** a session with a session id, a cwd, and a typed first prompt or a title, which isn't a subagent's sidechain or a headless (`sdk*`) run. Sessions are left out when:
  - serenity already knows them, archived included;
  - they're still running in tmux (`I` adopts those in place, as before);
  - they ran outside a git repo or in a bare repo;
  - their folder is gone. These can't resume and are only counted.
- **Grouped by repo.** A session's repo is the main checkout of its cwd's git common dir, so a worktree's sessions go onto the main repo's map. A map whose key is the same repo under another path keeps its own key.
- **An import parks the session; nothing runs.** The session goes onto its repo's map with `origin: "imported"`, `status: "dead"`, the transcript's cwd and branch, `worktree: null` and `ownsBranch: false`. Its card says "Imported. Enter resumes it.", and it stays out of NEEDS YOU, like an ended pinned session (0022). Enter resumes it through the 0022 path: a new window in its own folder running `claude --resume <id>` under serenity's hooks. From then on it is `spawned`. Importing 30 sessions starts no processes and spends no tokens. A large history only costs time when the user resumes it.
- **Never two claudes on one conversation.** Every resume, whether imported or pinned, first checks `<config>/sessions` for a live claude on that conversation. If it finds one, it refuses: "still open in another terminal (pid N); quit it there (/exit), then press Enter again". A session still open in a plain terminal can be imported anyway; the picker and the CLI flag it. Moving it is up to the user: quit it there, then press Enter here.
- **Three ways in:**
  - **`I` on the map** keeps "Running in your tmux" (0016). Below it, **From history** lists this repo's past sessions from the last 14 days. Each one shows its name, branch, title or first prompt, and last activity, plus its size when over 10 MB. Everything listed is ticked. `g` adds every other repo's, grouped by repo and unticked, so nothing lands on another map by accident. Enter adopts the tmux ones and imports the rest.
  - **`serenity import`** is the same for people without tmux. It runs from any terminal before a map has ever opened. It lists this repo's sessions, numbered and grouped, and asks which to import: Enter for all, `1 3 5-7`, or `n`. Options: `--days`, `--since`, `--until`, `--dir`, `--all-repos`, `--list`, `--yes`, or ids.
  - **The master's `import_sessions`** takes `since`/`until` (a date means that whole local day), `dir` (absolute, or relative to the repo), `ids` and `dry_run`, for "import my sessions from yesterday" or "import what I ran in packages/api". It stays in its own repo and that repo's worktrees, brings in at most 50 per call, and acts at once without a confirm, because importing runs nothing.
- **First boot points at it.** A map that opens with no sessions except the tutorial (0062) looks for this repo's past sessions. If there are any, it says "N Claude Code sessions from the last 14 days in this repo · I imports them" for 15 seconds. The empty map's text mentions `I` too.

## Consequences
- New users who don't use tmux can bring their work along with one command. Anyone can pull in a whole repo's recent history and resume conversations one at a time.
- An imported session is the user's checkout or worktree, not serenity's. Cleanup removes no worktree and deletes no branch, as for adopted sessions (0016).
- The history format isn't documented. Parsing tolerates missing fields, and a format change at worst hides sessions from the picker. It never breaks a map.
- The first listing reads about 300 KB per transcript (around half a second for 267 files). Later ones only reread files that changed.
- With `SERENITY_TMUX_SOCKET` set (dev, E2E), the e2e fake claude resumes imported sessions on the private server, so the whole flow is tested end to end.
