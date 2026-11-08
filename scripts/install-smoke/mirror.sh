#!/bin/sh
# Copies a release's assets (serenity-* and SHA256SUMS) into a directory
# without downloading them from the release (ADR 0056). GitHub counts every
# asset download, through the API too, so a smoke test that downloads them
# shows up as installs.
#
#   scripts/install-smoke/mirror.sh <tag> <dir>
#
# The binaries come from the workflow artifacts of the release.yml run that
# built them: the run after ci that tagged the release, or a rebuild dispatched for it.
# SHA256SUMS is rebuilt the way release.yml writes it. Every file must match
# the sha256 digest GitHub reports for the release asset, so the copy is
# byte-identical to what users download. Needs gh logged in (GH_TOKEN with
# contents and actions read in CI).
#
# Workflow artifacts expire (90 days). When none match it fails, unless
# MIRROR_ALLOW_DOWNLOAD=1: then it falls back to `gh release download` with a
# warning, which adds one download per asset to the release's counts.
set -eu

tag=$1
dir=$2
repo=${GITHUB_REPOSITORY:-mukkund1996/serenity}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
assets=$(gh api "repos/$repo/releases/tags/$tag" --jq '.assets[] | "\(.name) \(.digest // "")"')
digest() { printf '%s\n' "$assets" | awk -v f="$1" '$1 == f { sub(/^sha256:/, "", $2); print $2 }'; }
bins=$(printf '%s\n' "$assets" | awk '$1 ~ /^serenity-/ { print $1 }')
[ -n "$bins" ] || { echo "$tag has no serenity-* assets" >&2; exit 1; }
[ -n "$(digest SHA256SUMS)" ] || { echo "$tag has no SHA256SUMS (or no digest for it)" >&2; exit 1; }

mkdir -p "$dir"
commit=$(gh api "repos/$repo/commits/$tag" --jq .sha)
runs=$(
	gh api "repos/$repo/actions/workflows/release.yml/runs?head_sha=$commit&per_page=20" --jq '.workflow_runs[].id'
	gh api "repos/$repo/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=20" --jq '.workflow_runs[].id'
)

from_run() {
	# $1: run id. Fetches every binary from its artifacts; fails unless all match.
	rm -f "$dir"/serenity-* "$dir/SHA256SUMS"
	for b in $bins; do
		gh run download "$1" -R "$repo" -n "$b" -D "$dir" >/dev/null 2>&1 ||
			gh run download "$1" -R "$repo" -n "$b" -D "$dir" >/dev/null 2>&1 ||
			{ echo "run $1: no artifact $b" >&2; return 1; }
		[ "$(sha256 "$dir/$b")" = "$(digest "$b")" ] || { echo "run $1: $b differs from the release" >&2; return 1; }
	done
	# As release.yml's Checksums step: sha256sum serenity-* > SHA256SUMS
	(cd "$dir" && for b in serenity-*; do printf '%s  %s\n' "$(sha256 "$b")" "$b"; done >SHA256SUMS)
	[ "$(sha256 "$dir/SHA256SUMS")" = "$(digest SHA256SUMS)" ] || { echo "run $1: rebuilt SHA256SUMS differs from the release" >&2; return 1; }
}

for run in $runs; do
	if from_run "$run"; then
		echo "$tag: assets from release.yml run $run, all match the release's digests"
		ls -l "$dir"
		exit 0
	fi
done

note() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$1::$2"; else echo "$1: $2" >&2; fi; }
if [ "${MIRROR_ALLOW_DOWNLOAD:-}" != 1 ]; then
	note error "no release.yml run has artifacts matching $tag (they expire after 90 days). Set MIRROR_ALLOW_DOWNLOAD=1 to download from the release instead; that adds one download per asset to its counts"
	exit 1
fi
note warning "no release.yml run has artifacts matching $tag; downloading from the release, which adds one download per asset to its counts"
rm -f "$dir"/serenity-* "$dir/SHA256SUMS"
gh release download "$tag" -R "$repo" -D "$dir" -p 'serenity-*' -p SHA256SUMS
for f in $bins SHA256SUMS; do
	[ "$(sha256 "$dir/$f")" = "$(digest "$f")" ] || { echo "$f does not match the release's digest" >&2; exit 1; }
done
ls -l "$dir"
