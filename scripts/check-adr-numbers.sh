#!/bin/sh
# Fails when two ADRs in docs/adr share a number (ADR 0068). Parallel PRs each
# take "the next number"; with an up-to-date branch required before merge, the
# second PR to merge sees the clash here.
set -eu
dir=${1:-docs/adr}
dups=$(ls "$dir" | sed -n 's/^\([0-9][0-9]*\)-.*\.md$/\1/p' | sort | uniq -d)
[ -z "$dups" ] && { echo "ADR numbers in $dir are unique"; exit 0; }
for n in $dups; do
	files=$(ls "$dir" | grep "^$n-" | tr '\n' ' ')
	if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error::ADR $n is used twice: $files- renumber yours to the next free number"; fi
	echo "ADR $n is used twice: $files" >&2
done
exit 1
