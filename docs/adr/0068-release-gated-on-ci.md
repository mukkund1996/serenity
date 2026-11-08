# 0068 · Releases wait for a green main; flakes are retried once and named

**Status:** Accepted · 2026-11-08 · Amends [0014](0014-distribution-and-release.md), [0029](0029-website-on-github-pages.md), [0056](0056-ci-installs-out-of-download-counts.md)

## Context
Main went red several times (#71, #94, #113, #121), mostly from timing-dependent tests on one OS and from parallel PRs colliding (two ADRs taking the same number). Each time:
- **A red main could still ship.** `release.yml` ran on every push to main, beside `ci`, not after it. On 0d2c011 (#121) ci failed on macOS while release succeeded. Had that commit been a release PR merge, it would have tagged, built and bumped the Homebrew tap.
- **Nobody was told.** A failed push run shows only on the commit.
- **release-please's PR got no ci.** It pushes with `GITHUB_TOKEN`, which fires no `pull_request` event, so the release PR was merged unchecked or closed and reopened by hand.
- **install-smoke never ran by itself.** A release made with `GITHUB_TOKEN` fires no `release` event, so it was dispatched by hand.
- **The website deployed each commit twice.** It ran on a push to `website/**` and again after every `release` run. On 845554b (#119) both runs failed with "Deployment request failed … due to in progress deployment": the previous commit's second, redundant Pages deployment was still finishing.

The #121 failure itself was a test bug: in `daemon-link.test.ts` the "outdated map" test's `connect` used `world` before `make()` returned it. `start()` connects at once, so the first connect always threw a ReferenceError and the test passed only when a 0–2 ms retry beat the 20 ms daemon-start timer. A busy macOS runner lost that race.

## Decision
- **release runs after ci, for the commit ci passed.** `release.yml` triggers on `workflow_run` of `ci` on main. A `gate` job (`scripts/release-gate.sh`) lets it go on only when that ci run was for a **push**, **succeeded** (both OSes), and its commit is **still main's head** (release-please releases the head, so a newer commit waits for its own ci run). Otherwise release-please, build and publish are skipped with a notice. A manual rebuild of a tag (`workflow_dispatch`) needs a passing ci run for a push of the tag's commit.
- **ci runs on the release PR by dispatch.** After release-please creates or updates its PR, the release workflow runs `gh workflow run ci.yml --ref <its branch>`. `GITHUB_TOKEN` may dispatch workflows. A dispatched run's check runs are not linked to the PR (its check rollup stays empty), so on a dispatch ci also posts commit statuses named like its jobs (`check (ubuntu-latest)`, `check (macos-latest)`) on the head commit. The PR shows them and required checks accept them. The release step dispatches only when the PR's head has no ci run yet.
  - Not chosen: a GitHub App or PAT for release-please, so its pushes fire `pull_request` like a person's. It is the more "native" fix, but it adds a long-lived secret with write access that must be rotated, and its runs would also re-trigger other workflows. Switching later only means passing `token:` to the action; the dispatch is then redundant but harmless.
  - Not chosen: `pull_request_target`. It runs with write permissions on PR-controlled code paths and is easy to make unsafe.
- **publish dispatches install-smoke and the website.** Once the binaries and the tap bump are in place, the publish job dispatches `install-smoke.yml -f tag=<tag>` and `website.yml`. install-smoke still installs from the release run's mirrored artifacts (0056), so download counts stay clean. Its `release` trigger and wait-for-assets loop are removed: nothing fired them.
- **The website deploys once per reason.** Triggers: a push to main changing `website/**`, or that dispatch. The build job's concurrency group cancels an older build; the deploy job's group never cancels a running deploy (that can leave a Pages deployment stuck in progress) but queues. A failed `deploy-pages` waits 60 s and retries once, with a warning.
- **A red main opens an issue.** `main-health.yml` runs after ci on main. On failure it opens one issue labelled `main-red` (or comments on the open one) naming the failed jobs and steps, and comments on the PR the commit came from. The next green run comments and closes the issue.
- **e2e failures are retried once, never silently.** `bun run test:e2e:ci` (`scripts/test-retry-flaky.ts`) runs `bun test e2e` and reruns each failing file once on its own. A file that then passes is reported as **flaky** in a `::warning` annotation and the job summary, and the job stays green. A file that fails twice, or a failure outside any test file, fails the job. Unit tests are not retried: they must be deterministic.
- **Duplicate ADR numbers fail ci.** `bun run check:adr` (`scripts/check-adr-numbers.sh`) fails when two files in `docs/adr` share a number.
- **ci on a PR cancels its superseded runs**; runs on main never cancel, since release waits for them.
- **Not automated: branch protection.** Requiring `check (ubuntu-latest)` and `check (macos-latest)` and an up-to-date branch before merge is proposed to the maintainer, not applied by a workflow. Auto-merge stays off.

## Consequences
- A release lags its merge by one ci run (about 5 minutes).
- A red main stalls releases until it is fixed. The `main-red` issue says so.
- `workflow_run` workflows run from the default branch's copy of the file, so changes to `release.yml` or `main-health.yml` only take effect after they merge. `scripts/release-gate.sh` can be run locally against any ci run (see CONTRIBUTING.md).
- If a release PR's merge commit is red and a fix lands before ci finishes, release-please still tags the release PR's merge commit once the fix is green. Requiring ci on the release PR makes this unlikely; check the release's commit if it happens.
- A flaky e2e file still costs a rerun and shows a warning on every run where it flakes. A warning is a prompt to fix the test, not to ignore it.
- With an up-to-date branch required, the second of two PRs that take the same ADR number fails `check:adr` after rebasing, instead of on main.
