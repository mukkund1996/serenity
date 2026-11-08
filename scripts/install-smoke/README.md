# Install smoke test

Installs serenity the way the README tells users to, on clean machines, and checks that it runs headless: no Claude or GitHub login needed.

- `check.sh script [install.sh]` pipes the installer into `sh`, as `curl | sh` does. Without the argument, it uses the installer on main.
- `check.sh brew` follows the README's Homebrew steps: `brew install --cask claude-code` when `claude` is missing (the README's "If you don't have Claude Code yet" note), then `brew install mukkund1996/tap/serenity`.

After installing, `check.sh` checks:
- the binary is in `~/.local/bin` (or the brew prefix);
- the installer added that directory to the shell profile if it wasn't on PATH;
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

## Keeping out of the download counts

GitHub counts every download of a release asset, through the API too, and doesn't say who downloaded it. A smoke run that fetched from the release used to add about 33 downloads, which made CI look like users (ADR 0056). So CI installs from a copy:

- `mirror.sh <tag> <dir>` copies the release's binaries from the workflow artifacts of the `release.yml` run that built them, rebuilds `SHA256SUMS` the way that run did, and checks every file against the sha256 digest GitHub reports for the release asset. Artifact downloads aren't counted. If the run's artifacts have expired (90 days), it fails, unless `MIRROR_ALLOW_DOWNLOAD=1` lets it download from the release (one count per asset).
- `SERENITY_DOWNLOAD_BASE=file:///path/to/copy` makes `check.sh` install from that copy. The script method passes it to `install.sh`, which still downloads with curl and checks `SHA256SUMS`. The brew method taps `mukkund1996/tap` and rewrites the formula's release URLs to the copy, keeping its checksums. Both check that the copy was used.
- `SERENITY_ASSETS_DIR=<dir>` makes `docker.sh` mount the copy into each container and set `SERENITY_DOWNLOAD_BASE` there.

To run it locally the same way:

```bash
scripts/install-smoke/mirror.sh v0.9.0 /tmp/serenity-mirror
SERENITY_ASSETS_DIR=/tmp/serenity-mirror scripts/install-smoke/docker.sh ubuntu:24.04,linux/amd64,sudo
```

Release binaries are built for glibc only, so Alpine (musl) isn't supported.

## macOS, and all of it in CI

macOS can't run in Docker. `.github/workflows/install-smoke.yml` runs `check.sh` on GitHub's Apple Silicon (`macos-latest`) and Intel (`macos-15-intel`) runners, with both methods, alongside the Linux matrix. Those runners aren't fully clean: Homebrew, git and gh are already there. To cover a new Mac, the `script-nobrew` case uninstalls Homebrew first, so the installer has to install it. That case runs on Apple Silicon only, because Homebrew no longer installs on Intel Macs.

The workflow runs on:
- manual dispatch;
- a pull request that touches the installer;
- each published release. On a release it first waits for the binaries and the tap bump.

Its `mirror` job copies the release's assets as above and the install jobs read that copy. Each run pins the version of the release it copied.
