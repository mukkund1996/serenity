# 0056 · CI installs stay out of the release download counts

**Status:** Accepted · 2026-11-03 · Amends 0025 · Amended by [0068](0068-release-gated-on-ci.md)

## Context
GitHub's per-asset `download_count` is the only install number a release has, and it can't be filtered: GitHub doesn't record who downloaded what. The install smoke test (`.github/workflows/install-smoke.yml`) installs the way users do, so every run fetched from the release: 15 script jobs each downloaded a binary and `SHA256SUMS`, and 3 Homebrew jobs a binary through the tap formula. That is about 33 downloads a run. Matched against the runs, they account for almost all of v0.7.0–v0.9.0's downloads. Downloads through the authenticated API (`gh release download`) count too, so fetching once per run with a token only shrinks the problem.

## Decision
- **`SERENITY_DOWNLOAD_BASE`** in `scripts/install.sh`: an `https://` or `file:///` URL to a directory that replaces the release as the source of `serenity-<os>-<arch>` and `SHA256SUMS`. The rest of the path is unchanged: curl download, checksum, install, PATH guidance. Anything else (plain http, a bare path) is refused, and the installer says when the override is in use. The checksums come from the same place, so the override is only as trustworthy as the copy. It is documented as such in the README. Unset, nothing changes for users.
- **install-smoke installs from a copy.** Its `mirror` job runs `scripts/install-smoke/mirror.sh`. That script takes the binaries from the workflow artifacts of the `release.yml` run that built the release. Artifact downloads aren't counted. It rebuilds `SHA256SUMS` the way that run did and checks every file against the sha256 `digest` GitHub reports for the release asset, so the copy is byte-identical to what users download. The install jobs get the copy as a workflow artifact and set `SERENITY_DOWNLOAD_BASE=file://…`, or `SERENITY_ASSETS_DIR` for the Docker cases. The Homebrew cases tap the real formula and rewrite its release URLs to the copy, keeping its checksums. `check.sh` fails a case that didn't use the copy.
- **Expired artifacts fail the run instead of downloading.** Workflow artifacts last 90 days. A manual dispatch with `allow_release_download` falls back to downloading from the release, adding one count per asset, with a warning.
- **No install telemetry.** `install.sh` sends nothing anywhere, so there is no ping to keep CI out of. Adding one would be a separate decision.
- **`scripts/stats/downloads.ts`** reports downloads per release and asset. It subtracts what install-smoke runs from before this ADR fetched, reconstructed from their job history against the release that was latest when each job started. Runs with a `mirror` job subtract nothing.
- **Clone and traffic numbers** stay as they are: every CI job's `actions/checkout` counts, and nothing filters them. CONTRIBUTING says not to read them as adoption.

## Consequences
- From the first smoke run with this change, release download counts are people (and anyone with repo access downloading by hand). `SHA256SUMS` approximates curl-installer installs. The binaries also count Homebrew and manual downloads.
- The public download URL itself is no longer exercised by CI. That URL is GitHub's stable `releases/{latest/,}download/<asset>` form. The mirror checks that the release's assets exist under the names `install.sh` expects, and that they match the copy.
- install-smoke needs `actions: read` on its token to read `release.yml`'s artifacts. `release.yml` itself is unchanged.
