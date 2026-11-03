# 0058 · A settings panel (Ctrl+,) and a base branch for new worktrees

**Status:** Accepted · 2026-11-03 · Amends [0010](0010-worktrees-beside-repo.md) (what a new worktree branches off) and [0012](0012-ux-decisions.md) (config is also written, by the daemon)

## Context
A new session's worktree always branched off the repo's default branch, origin's HEAD (0010). Teams that work off `develop` or a release branch had to rebase every session, and nothing let one repo differ from another. Changing any setting meant editing `~/.config/serenity/config.json` by hand and running `serenity restart`.

## Decision
- **Base branch setting.** `baseBranch` in config.json is `"default"` (origin's HEAD, as before, and the default), `"current"` (the branch the repo's main checkout is on when the session starts) or `{ "branch": "<name>" }`. `repos.<path>.baseBranch` sets it for one repo (the path is written `~/…` or absolute and compared as its real path, like `slack.repos`); a repo with none follows the global one. Keyword strings and an object for a name keep a branch called `current` possible.
- **Resolution.** A named branch is taken locally first (`refs/heads/<name>`), else from origin (`origin/<name>`, as of the last fetch; serenity does not fetch). When the setting cannot be followed (no such branch, or the main checkout is on a detached HEAD), the repo default is used and the notice says why (`no branch develop here or on origin; using origin/main`). It shows in the panel and the New session dialog before anything is created, and in `daemon.log` when a session is made. Sessions the master starts (`create_session`, `@new`, Slack follow-ups) resolve it the same way; its tool result names the base.
- **Per-session override.** The New session dialog has a **Base** field showing the branch the setting gives. A branch typed there is used for that session only. It is refused, not replaced, when it exists neither locally nor on origin, since the user typed it just now. It is ignored for "existing branch", which makes no new branch.
- **Each session records its base** (`session.base`: the ref and the branch a PR would target). Cleanup counts unmerged commits against it rather than the repo default, so a session off `develop` is not reported as holding develop's commits. PR lookup (0055) leaves out the session's own base rather than the repo default. Sessions from before this have no base and keep the old behaviour.
- **The settings panel.** `Ctrl+,` opens it from any map view, a text field's too; `,` on the map opens it as well. It is an overlay like the other dialogs. `↑` `↓` (or `Tab`) move, `Enter` or `Space` change a row, `←` `→` step back and forth, `Esc` (or `Ctrl+,`) closes. A named branch or a number is typed in place: `Enter` saves, `Esc` cancels. The rows:

  | Row | Values | Takes effect |
  |---|---|---|
  | Base branch · This repo | as all repos · repo default · current branch · a named branch | new sessions |
  | Base branch · All repos | repo default · current branch · a named branch | new sessions |
  | Master models · Chat / Summarizer / Suggester | opus · sonnet · haiku (a custom id from the file stays a choice) | summarizer and suggester now; the chat after `serenity restart` |
  | Topics · Max topics | 1–30 | now |
  | Slack · This repo | on · off (`slack.repos`) | the map now; the master's Slack tools after `serenity restart` |

  Below the rows the panel says where new sessions in this repo branch off, or the fallback notice. After each save it says when the change applies.
- **The daemon owns config.json.** `config.get` reads the file again and returns the panel's values; `config.set` writes one change and applies it; `base.resolve` answers the dialog. The TUI never reads or writes the file itself, so the two cannot disagree. Hand edits are picked up the next time the panel opens.
- **Writes keep the file.** Only the keys the change names are touched. Unknown keys, key order, the indent and the trailing newline are kept. The new text goes to a temporary file beside it, which is renamed over, so a reader never sees half a file. A new file is created 0600, since it may hold Slack's MCP settings; an existing file keeps its mode. A file that is not valid JSON is refused with the parse error rather than replaced, so a hand edit with a typo is never lost.
- **How Ctrl+, reaches the map.** It has no control byte, so it only arrives from a terminal sending extended keys. That is tmux's `extkeys`, which serenity turns on (0038): iTerm2, Ghostty, kitty, WezTerm and others send `ESC[27;5;44~` or `ESC[44;5u`, both of which tmux reads as `C-,`. Like `S-Enter`, serenity binds `C-,` in tmux's root table. In the map pane (`@serenity_map`) it sends `ESC[44;5u`, which Ink reads as `,` with Ctrl. Anywhere else it passes the key on. The 5 s binding check (0051) covers it too. Without extended keys (Apple Terminal), tmux delivers a plain `,` or nothing, which is why `,` on the map opens the panel too.

## Consequences
- Worktree location, reviewers and crash reports stay file-only; the panel lists the few settings worth changing often. `serenity restart` is still how the master's chat and the crash reporter pick up changes.
- A named base that exists only on origin is as fresh as the last `git fetch` in the repo.
- With a base other than the default, a new branch made from `origin/<name>` tracks it, as one made from `origin/main` always has; one made from a local branch tracks nothing. PR lookup already ignores an upstream that is not the branch's own push target (0055).
- `,` is taken on the map. In a text field it is still a comma; only `Ctrl+,` opens the panel there.
