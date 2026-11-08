#!/bin/sh
# Installs serenity and the tools it needs (ADR 0014, 0025):
# tmux, git, gh and Claude Code, then the serenity binary for this machine,
# checked against the release's checksums.
#
#   curl -fsSL https://raw.githubusercontent.com/mukkund1996/serenity/main/scripts/install.sh | sh
#
# Environment:
#   SERENITY_VERSION      release to install, e.g. 0.5.0 (default: latest)
#   SERENITY_INSTALL_DIR  where the binary goes (default: ~/.local/bin)
#   SERENITY_NO_DEPS=1    only install serenity, leave the tools alone
#   SERENITY_DOWNLOAD_BASE  where to fetch serenity-<os>-<arch> and SHA256SUMS
#                         from instead of the GitHub release, as an https:// or
#                         file:/// URL to a directory. For CI and mirrors (ADR 0056):
#                         the checksums come from the same place, so only point
#                         it at a copy you trust.
#   SERENITY_NO_OPEN=1    don't open the docs in a browser at the end (the URL
#                         is printed either way; CI and machines with no
#                         display never open it)
set -eu

REPO="mukkund1996/serenity"
DOCS_URL="https://getserenity.dev/docs/"
INSTALL_DIR="${SERENITY_INSTALL_DIR:-$HOME/.local/bin}"
# The user's PATH, before installing Claude Code adds ~/.local/bin to ours.
USER_PATH="$PATH"

# Colours only on a terminal, so logs and pipes get plain text.
# $1: fd, $2: SGR code, $3: text
paint() { if [ -t "$1" ]; then printf '\033[%sm%s\033[0m' "$2" "$3"; else printf '%s' "$3"; fi; }
say() { paint 1 1 "$*"; echo; }
warn() { { paint 2 33 "! $*"; echo; } >&2; }
die() { { paint 2 31 "✗ $*"; echo; } >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

sudo_cmd() {
	if [ "$(id -u)" -eq 0 ]; then "$@"; elif has sudo; then sudo "$@"; else die "need root to run: $*"; fi
}

# ── platform ────────────────────────────────────────────────────────────────
case "$(uname -s)" in
	Darwin) os=darwin ;;
	Linux) os=linux ;;
	*) die "serenity runs on macOS and Linux, not $(uname -s)" ;;
esac
case "$(uname -m)" in
	arm64 | aarch64) arch=arm64 ;;
	x86_64 | amd64) arch=x64 ;;
	*) die "unsupported CPU: $(uname -m)" ;;
esac
# A shell under Rosetta reports x86_64; the native build is faster.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
	arch=arm64
fi

# ── tools ───────────────────────────────────────────────────────────────────
brew_shellenv() {
	for b in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
		[ -x "$b" ] && eval "$("$b" shellenv)" && return 0
	done
	return 1
}

install_packages() {
	# $@: package names, the same for every manager we use
	if has brew; then
		brew install "$@"
	elif has apt-get; then
		sudo_cmd apt-get update -qq && sudo_cmd apt-get install -y "$@"
	elif has dnf; then
		sudo_cmd dnf install -y "$@"
	elif has pacman; then
		sudo_cmd pacman -S --needed --noconfirm "$@"
	elif has zypper; then
		sudo_cmd zypper --non-interactive install "$@"
	elif has apk; then
		sudo_cmd apk add "$@"
	else
		return 1
	fi
}

tmux_ok() {
	has tmux || return 1
	v=$(tmux -V | sed -E 's/[^0-9]*([0-9]+)\.([0-9]+).*/\1 \2/')
	set -- $v
	[ "${1:-0}" -gt 3 ] || { [ "${1:-0}" -eq 3 ] && [ "${2:-0}" -ge 2 ]; }
}

install_homebrew() {
	say "Installing Homebrew (for tmux and gh)"
	brew_installer=$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh) || return 1
	# Our stdin is /dev/null (see below), so Homebrew would run non-interactively
	# and could not ask for the sudo password it needs. Give it the terminal.
	if (exec </dev/tty) 2>/dev/null; then
		/bin/bash -c "$brew_installer" </dev/tty || return 1
	else
		/bin/bash -c "$brew_installer" || return 1
	fi
	brew_shellenv
}

install_tools() {
	# Homebrew only if something is missing: it no longer installs on Intel Macs,
	# where tmux can come from MacPorts instead.
	if [ "$os" = darwin ] && { ! tmux_ok || ! has git || ! has gh; } && ! has brew && ! brew_shellenv; then
		install_homebrew || warn "Homebrew did not install (it no longer supports Intel Macs); install tmux 3.2+ and gh another way, such as MacPorts"
	fi

	missing=""
	tmux_ok || missing="$missing tmux"
	has git || missing="$missing git"
	if [ -n "$missing" ]; then
		say "Installing$missing"
		# shellcheck disable=SC2086
		install_packages $missing || die "could not install$missing; install them and run this again"
	fi
	tmux_ok || die "serenity needs tmux 3.2 or newer (have: $(tmux -V 2>/dev/null || echo none))"

	if ! has gh; then
		say "Installing gh"
		install_packages gh || warn "could not install gh; PR status needs it: https://cli.github.com"
	fi

	if ! has claude; then
		say "Installing Claude Code"
		curl -fsSL https://claude.ai/install.sh | bash || die "Claude Code did not install: https://claude.com/claude-code"
		PATH="$HOME/.local/bin:$PATH"
	fi
}

# ── serenity ────────────────────────────────────────────────────────────────
sha256() {
	if has sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

install_serenity() {
	asset="serenity-$os-$arch"
	if [ -n "${SERENITY_DOWNLOAD_BASE:-}" ]; then
		base="${SERENITY_DOWNLOAD_BASE%/}"
		case "$base" in
			https://* | file:///*) ;;
			*) die "SERENITY_DOWNLOAD_BASE must be an https:// or file:/// URL, not: $base" ;;
		esac
		say "Using serenity from $base (SERENITY_DOWNLOAD_BASE)"
	elif [ -n "${SERENITY_VERSION:-}" ]; then
		base="https://github.com/$REPO/releases/download/v${SERENITY_VERSION#v}"
	else
		base="https://github.com/$REPO/releases/latest/download"
	fi
	tmp=$(mktemp -d)
	trap 'rm -rf "$tmp"' EXIT

	say "Downloading $asset"
	curl -fsSL -o "$tmp/$asset" "$base/$asset" || die "download failed: $base/$asset"
	curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "download failed: $base/SHA256SUMS"
	want=$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
	[ -n "$want" ] || die "$asset is not in SHA256SUMS"
	[ "$(sha256 "$tmp/$asset")" = "$want" ] || die "checksum mismatch for $asset"

	mkdir -p "$INSTALL_DIR"
	chmod 755 "$tmp/$asset"
	# Move then rename: macOS kills a running binary that is overwritten in place.
	mv "$tmp/$asset" "$INSTALL_DIR/serenity.new"
	mv "$INSTALL_DIR/serenity.new" "$INSTALL_DIR/serenity"
	# A running daemon of an older build is replaced the next time serenity connects.
	say "Installed $INSTALL_DIR/serenity ($("$INSTALL_DIR/serenity" version))"
}

# ── docs ────────────────────────────────────────────────────────────────────
# The browser command for this machine, or nothing when no browser should
# open: opted out, CI, or no display (ADR 0062).
browser_cmd() {
	[ "${SERENITY_NO_OPEN:-}" = 1 ] && return 1
	[ -n "${CI:-}" ] && return 1
	if [ "$os" = darwin ]; then
		# Over SSH there is no screen in front of the user, even if `open` works.
		[ -z "${SSH_CONNECTION:-}" ] && [ -z "${SSH_TTY:-}" ] || return 1
		has open && echo open
	else
		[ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ] || return 1
		has xdg-open && echo xdg-open
	fi
}

open_docs() {
	printf '  Docs: %s\n' "$DOCS_URL"
	cmd=$(browser_cmd) || return 0
	[ -n "$cmd" ] || return 0
	"$cmd" "$DOCS_URL" >/dev/null 2>&1 </dev/null || true
}

# What to do now, with the star link (README "Quick start", the formula's caveats).
next_steps() {
	echo
	say "serenity is installed."
	echo
	if repo=$(git rev-parse --show-toplevel 2>/dev/null); then
		printf "Next: you're in %s, so just run  " "${repo##*/}"
		paint 1 1 serenity
		echo
	else
		echo "Next:"
		printf '  1. cd into a git repo you work in   '
		paint 1 1 "cd ~/path/to/your/repo"
		printf '\n  2. open serenity                    '
		paint 1 1 serenity
		echo
	fi
	case ":$USER_PATH:" in
		*":$INSTALL_DIR:"*) ;;
		*) printf '  (If serenity is not found, first run: export PATH="%s:%s")\n' "$INSTALL_DIR" "\$PATH" ;;
	esac
	echo "  First run: import past sessions, connect GitHub and Slack, take a short tour."
	open_docs
	echo
	paint 1 32 "★"
	printf ' Like it? Star the repo: https://github.com/%s\n' "$REPO"
}

# Under `curl | sh` the rest of this script is on stdin: a package manager or
# installer that reads stdin would swallow it, and sh would exit 0 halfway.
[ "${SERENITY_NO_DEPS:-}" = 1 ] || install_tools </dev/null
install_serenity

echo
"$INSTALL_DIR/serenity" doctor || true
case ":$USER_PATH:" in
	*":$INSTALL_DIR:"*) ;;
	*) warn "$INSTALL_DIR is not on your PATH; add it to your shell profile: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
has gh && ! gh auth status >/dev/null 2>&1 && warn "log in to GitHub for PR status: gh auth login"
next_steps
