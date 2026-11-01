#!/bin/sh
# Runs check.sh in fresh Linux containers: each image × platform × user.
#
#   scripts/install-smoke/docker.sh [-o logdir] [case ...]
#
# A case is image,platform,user: user is "root", or "sudo" for a non-root
# user with passwordless sudo, or "brew" for Homebrew on Linux. With no cases,
# runs the default matrix below. The installer under test is this checkout's
# scripts/install.sh, piped into sh the way `curl | sh` does.
set -u

here=$(cd "$(dirname "$0")" && pwd)
installer="$here/../install.sh"
logdir="${TMPDIR:-/tmp}/serenity-install-smoke"
if [ "${1:-}" = -o ]; then
	logdir=$2
	shift 2
fi
mkdir -p "$logdir"

if [ $# -eq 0 ]; then
	set -- \
		ubuntu:24.04,linux/amd64,sudo ubuntu:24.04,linux/amd64,root \
		ubuntu:24.04,linux/arm64,sudo ubuntu:24.04,linux/arm64,root \
		debian:stable-slim,linux/amd64,sudo debian:stable-slim,linux/amd64,root \
		debian:stable-slim,linux/arm64,sudo debian:stable-slim,linux/arm64,root \
		fedora:latest,linux/amd64,sudo fedora:latest,linux/amd64,root \
		fedora:latest,linux/arm64,sudo fedora:latest,linux/arm64,root
fi

# What a bare image lacks that any desktop or server has: curl, CA
# certificates and, for the sudo case, sudo and a user who may use it.
prep='set -e
if command -v apt-get >/dev/null; then
	apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates $EXTRA >/dev/null
elif command -v dnf >/dev/null; then
	dnf install -y -q curl ca-certificates $EXTRA >/dev/null
fi
rm -rf /var/lib/apt/lists/*
if [ "$MODE" != root ]; then
	useradd -m -s /bin/bash smoke
	echo "smoke ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/smoke
fi'

results=""
overall=0
for case in "$@"; do
	IFS=, read -r image platform mode <<EOF
$case
EOF
	name=$(printf '%s-%s-%s' "$image" "$platform" "$mode" | tr ':/' '__')
	extra=""
	# sudo drops the environment, so the pin goes in the command.
	pin="SERENITY_EXPECT_VERSION=${SERENITY_EXPECT_VERSION:-}"
	run="cd; export $pin; sh /smoke/check.sh script /smoke/install.sh"
	case "$mode" in
	sudo) extra=sudo ;;
	brew)
		# Homebrew on Linux wants a compiler and git, and refuses to run as root.
		extra="sudo git procps file build-essential gcc"
		run='NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" >/dev/null &&
			eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" && sh /smoke/check.sh brew'
		run="cd; export $pin; $run"
		;;
	esac
	# Not su: Fedora's image has none. sudo resets the environment.
	if [ "$mode" = root ]; then as="sh -c"; else as="sudo -u smoke -H sh -c"; fi
	printf '%-55s ' "$case"
	docker run --rm --platform "$platform" \
		-v "$here/check.sh:/smoke/check.sh:ro" -v "$installer:/smoke/install.sh:ro" \
		-e MODE="$mode" -e EXTRA="$extra" \
		"$image" sh -c "$prep
$as '$run'" >"$logdir/$name.log" 2>&1
	status=$?
	if [ $status -eq 0 ]; then verdict=PASS; else verdict=FAIL overall=1; fi
	echo "$verdict  ($logdir/$name.log)"
	results="$results$verdict $case
"
done

echo
printf '%s' "$results"
exit "$overall"
