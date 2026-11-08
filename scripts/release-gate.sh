#!/bin/sh
# Decides whether the release workflow may tag, build and publish (ADR 0068).
# Prints go=true or go=false (append it to $GITHUB_OUTPUT) and why.
#
# After ci (workflow_run), all of these must hold:
#   EVENT=push           ci ran for a push to main, not a PR or a dispatch
#   CONCLUSION=success   that run passed on every OS
#   SHA = main's head    release-please releases main's head, so a newer
#                        commit waits for its own ci run
# A rebuild of an existing tag (workflow_dispatch, TAG set) needs a passing
# ci run for a push of the tag's commit.
#
#   EVENT=push CONCLUSION=success SHA=<sha> scripts/release-gate.sh
#   TAG=v0.11.0 scripts/release-gate.sh
#
# MAIN_HEAD overrides the lookup of main's head (for tests).
set -eu
repo=${GITHUB_REPOSITORY:-mukkund1996/serenity}

note() { if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$1::$2" >&2; else echo "$1: $2" >&2; fi; }
stop() { note notice "no release: $1"; echo go=false; exit 0; }

if [ -n "${TAG:-}" ]; then
	sha=$(gh api "repos/$repo/commits/$TAG" --jq .sha)
	passed=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?head_sha=$sha&event=push&status=success&per_page=1" --jq .total_count)
	if [ "$passed" -gt 0 ]; then
		echo "ci passed on $TAG ($sha)" >&2
		echo go=true
		exit 0
	fi
	note error "no passing ci run for a push of $TAG ($sha); not rebuilding it"
	echo go=false
	exit 1
fi

[ "${EVENT:-}" = push ] || stop "ci ran for a ${EVENT:-unknown} event, not a push to main"
[ "${CONCLUSION:-}" = success ] || stop "ci ${CONCLUSION:-did not finish} on ${SHA:-?}; a red main never releases"
head=${MAIN_HEAD:-$(gh api "repos/$repo/commits/main" --jq .sha)}
[ "$head" = "${SHA:-}" ] || stop "main moved on from $SHA to $head; the newer commit's ci run decides"
echo "ci passed on main's head $SHA" >&2
echo go=true
