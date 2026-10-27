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
set -eu

REPO="mukkund1996/serenity"
INSTALL_DIR="${SERENITY_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
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

install_tools() {
	if [ "$os" = darwin ] && ! has brew && ! brew_shellenv; then
		say "Installing Homebrew (for tmux and gh)"
		/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
		brew_shellenv || die "Homebrew did not install"
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
	if [ -n "${SERENITY_VERSION:-}" ]; then
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

[ "${SERENITY_NO_DEPS:-}" = 1 ] || install_tools
install_serenity

echo
"$INSTALL_DIR/serenity" doctor || true
echo
case ":$PATH:" in
	*":$INSTALL_DIR:"*) ;;
	*) warn "$INSTALL_DIR is not on your PATH; add it to your shell profile: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
has gh && ! gh auth status >/dev/null 2>&1 && warn "log in to GitHub for PR status: gh auth login"
say "Done. Run serenity inside any git repo."
