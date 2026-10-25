# 0016 · Importing Claude sessions already running in tmux

**Status:** Accepted · 2026-10-25

## Context
To dogfood serenity, the user wants the Claude sessions they already run in their own tmux windows on the map, without stopping them. Those sessions were started without serenity's hooks (0006), and Claude Code reads hook settings only at startup.

Claude Code writes two things anyway:
- `<config>/sessions/<pid>.json` for every running claude, with its session id, cwd, tmux pane (`"guide:@166.%258"`), a status (`idle`, `busy`, `waiting` + `waitingFor`, `needs_trust`), and its kind (`interactive`, `bg`).
- The transcript, `<config>/projects/<cwd with non-alphanumerics as "-">/<session id>.jsonl`, with `ai-title` / `custom-title`, `last-prompt` and assistant entries (and `gitBranch`).

`<config>` is `CLAUDE_CONFIG_DIR`, else `~/.claude`. Neither file is a documented interface.

## Decision
- **Picker, not auto-discovery.** `I` on the map lists the interactive claudes that are running in a tmux pane on serenity's tmux server, in this repo or one of its worktrees (same git common dir), and not already on the map. All are ticked; Space toggles, `a` all/none, Enter imports.
- **Adopt in place, upgrade later.** An imported session has `origin: "adopted"` and `tracking: "observed"`. It stays in the user's window. Its status comes from the session file. Its prompt, reply, title and branch come from the transcript tail, so the Haiku summary, topics and the Sonnet suggestions work as for spawned sessions. While it waits, serenity reads the pane: a numbered menu starting "1. Yes" is a permission prompt, which makes approve (`y` presses "1") available. Any other wait is a question.
- **Change detection:** an `fs.watch` on the sessions folder (settled for 200 ms), plus a 30 s sweep as a safety net. A session is re-read when its status, `waitingFor` or transcript size changes. A claude whose file is gone or whose pid is dead marks the session ended.
- **`U` restarts it under hooks:** only while Claude is idle, `respawn-pane -k` runs `claude --resume <id> --settings <hooks>` under the usual exit-report wrapper, in the same pane. From then on `tracking` is `"hooks"`. The pane still lives in the user's window.
- **Names** come from the tmux window name (`dump-mode-fe`), else Claude's title, else Claude's own name, slugged and made unique.
- **Attach goes to its window.** Enter switches the tmux client showing the map to the adopted pane (`switch-client -t <pane>`). Ctrl+g there, or Esc in the map, switches back. New sessions keep the usual join-beside-the-map flow (0004).
- **Cleanup** of an observed session stops claude (SIGTERM to its pid) and leaves the user's shell and window. It removes no worktree and deletes no branch: `worktree` is null and `ownsBranch` is false.
- **PRs:** the PR of the branch is shown, but a merge does not mark an imported session finished. Several imported sessions often share one checkout and so one branch.

## Consequences
- Observed status is coarser than hooks: there is no per-tool "wants to run X" outside permission prompts, and the ask for other waits is Claude's generic `waitingFor` text. `U` is the way to full detail.
- A Claude Code update can change either file; parsing ignores unknown fields and falls back to idle. Keep `packages/core/src/observed.ts` the one place that knows these formats.
- With `SERENITY_TMUX_SOCKET` set (dev, E2E) only claudes on that private tmux server can be imported.
- The E2E fake claude writes both files too, so the import flow is tested end to end.
