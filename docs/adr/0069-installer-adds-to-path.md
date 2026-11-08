# 0069 · The installer adds its directory to the shell profile

**Status:** Accepted · 2026-11-08 · Amends [0025](0025-install-script-and-homebrew.md)

## Context
`scripts/install.sh` puts the binary in `~/.local/bin`. When that directory wasn't on PATH, the installer printed one yellow line asking the user to add it to their shell profile, among the output of the tool installs and `serenity doctor`. It is easy to miss, and the user's first `serenity` then fails with "command not found". Claude Code's installer uses the same directory, so this mostly showed up on fresh machines and in containers, which is exactly where a new user tries serenity first.

## Decision
- **When the install directory isn't on the user's PATH, the installer appends one line to the profile their login shell reads**, under a `# Added by the serenity installer` comment:
  - zsh: `${ZDOTDIR:-~}/.zshrc`
  - bash: `~/.bashrc` on Linux, `~/.bash_profile` on macOS (its terminals start login shells, which skip `.bashrc`)
  - fish: `~/.config/fish/conf.d/serenity.fish` with `fish_add_path`
  - anything else: `~/.profile`

  The shell comes from `$SHELL`, or the passwd entry when that is unset (containers). The line names `$HOME/...` rather than the expanded path.
- **It adds the line once.** If the profile already has it, nothing is written.
- **It says what it did**: the profile it changed, and that this terminal needs a new window or the `export` line.
- **`SERENITY_NO_MODIFY_PATH=1` opts out**, and the installer prints the line to add instead, as before. A profile it can't write gets the same warning.
- Homebrew is unchanged: its `bin` is already on PATH.

## Consequences
- `serenity` works in the next terminal after `curl | sh`, with no manual step.
- The installer now writes outside its install directory. The comment marks the line so users can find and remove it.
- install-smoke's `check.sh` checks that the profile the installer names contains the directory, instead of looking for the warning.
