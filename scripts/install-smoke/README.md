# Install smoke test

Installs serenity the way the README tells users to, on clean machines, and checks that it runs headless: no Claude or GitHub login needed.

- `check.sh script [install.sh]` pipes the installer into `sh`, as `curl | sh` does. Without the argument, it uses the installer on main.
- `check.sh brew` runs the README's Homebrew line: `brew install --cask claude-code; brew install mukkund1996/tap/serenity`.

After installing, `check.sh` checks:
- the binary is in `~/.local/bin` (or the brew prefix);
- the installer printed PATH guidance if that directory wasn't on PATH;
- `serenity --version` reports a version, or the `SERENITY_EXPECT_VERSION` you set;
- tmux 3.2+, git, gh and claude are on PATH;
- `help` and `doctor` work;
- `restart` starts the daemon and `stop` stops it;
- the map renders in a detached tmux pane.

## Linux, in Docker

```bash
scripts/install-smoke/docker.sh                                  # the default matrix
scripts/install-smoke/docker.sh fedora:latest,linux/arm64,sudo   # one case
scripts/install-smoke/docker.sh -o logs ubuntu:24.04,linux/amd64,brew
```

A case is `image,platform,user`. `user` takes one of three values:
- `root`;
- `sudo`, a non-root user with passwordless sudo;
- `brew`, which installs Homebrew on Linux as a non-root user, then runs `check.sh brew`.

The containers get only `curl` and CA certificates first, plus `sudo` and a user where the case needs them. Everything else is the installer's job. They run this checkout's `scripts/install.sh` against the latest release's binaries.

Release binaries are built for glibc only, so Alpine (musl) isn't supported.

## macOS, and all of it in CI

macOS can't run in Docker. `.github/workflows/install-smoke.yml` runs `check.sh` on GitHub's Apple Silicon (`macos-latest`) and Intel (`macos-15-intel`) runners, with both methods, alongside the Linux matrix. Those runners aren't fully clean: Homebrew, git and gh are already there. To cover a new Mac, the `script-nobrew` case uninstalls Homebrew first, so the installer has to install it. That case runs on Apple Silicon only, because Homebrew no longer installs on Intel Macs.

The workflow runs on:
- manual dispatch;
- a pull request that touches the installer;
- each published release. On a release it first waits for the binaries and the tap bump, then pins the version.
