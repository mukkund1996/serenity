#!/bin/sh
# Install smoke test, run on the machine under test (a fresh container or CI
# runner). Installs serenity the way a user does, then checks it works
# headless: no Claude or GitHub login needed.
#
#   check.sh script [install.sh]  pipe install.sh into sh, as `curl | sh` does
#   check.sh brew                 brew install mukkund1996/tap/serenity
#
# The script method defaults to the install.sh on main. SERENITY_EXPECT_VERSION
# (e.g. 0.7.0) pins the version `serenity version` must report.
set -u

method="${1:-script}"
installer="${2:-}"
bin_dir="${SERENITY_INSTALL_DIR:-$HOME/.local/bin}"
log="${TMPDIR:-/tmp}/serenity-install.log"
failed=0

pass() { printf 'PASS  %s\n' "$*"; }
fail() {
	printf 'FAIL  %s\n' "$*"
	failed=1
}
check() {
	# check "<label>" command...: pass when the command exits 0
	label=$1
	shift
	if "$@" >/dev/null 2>&1; then pass "$label"; else fail "$label"; fi
}

echo "── $(uname -s) $(uname -m) · $(id -un) (uid $(id -u)) · method $method"
path_before=$PATH

# ── install ─────────────────────────────────────────────────────────────────
case "$method" in
script)
	if [ -n "$installer" ]; then
		sh <"$installer" >"$log" 2>&1
	else
		curl -fsSL https://raw.githubusercontent.com/mukkund1996/serenity/main/scripts/install.sh | sh >"$log" 2>&1
	fi
	status=$?
	;;
brew)
	# The README's line, as given.
	{ brew install --cask claude-code; brew install mukkund1996/tap/serenity && brew test serenity; } >"$log" 2>&1
	status=$?
	bin_dir=$(brew --prefix)/bin
	;;
*)
	echo "unknown method: $method" >&2
	exit 2
	;;
esac
sed 's/^/  │ /' "$log"
[ "$status" -eq 0 ] && pass "installer exits 0" || fail "installer exits 0 (exit $status)"

# ── binary and PATH guidance ────────────────────────────────────────────────
check "binary at $bin_dir/serenity" test -x "$bin_dir/serenity"
if [ "$method" = script ]; then
	case ":$path_before:" in
	*":$bin_dir:"*) pass "PATH guidance not needed ($bin_dir already on PATH)" ;;
	*) check "PATH guidance printed for $bin_dir" grep -q "is not on your PATH" "$log" ;;
	esac
fi

# From here on, a shell that followed the guidance: Claude Code's own
# installer also puts claude in ~/.local/bin.
PATH="$bin_dir:$HOME/.local/bin:$PATH"
export PATH

version=$(serenity --version 2>&1)
want="${SERENITY_EXPECT_VERSION#v}"
# Unquoted, so [0-9] is a pattern: a pinned version, or any.
pattern="${want:-[0-9]}*+*"
# shellcheck disable=SC2254
case "$version" in
$pattern) pass "serenity --version: $version" ;;
*) fail "serenity --version: $version (want ${SERENITY_EXPECT_VERSION:-x.y.z}+build)" ;;
esac

# ── tools ───────────────────────────────────────────────────────────────────
for tool in tmux git gh claude; do
	if command -v "$tool" >/dev/null 2>&1; then
		pass "$tool on PATH: $(command -v "$tool")"
	else
		fail "$tool on PATH"
	fi
done
tmux_v=$(tmux -V 2>/dev/null)
case "$tmux_v" in
"tmux 3."[2-9]* | "tmux 3."[1-9][0-9]* | "tmux "[4-9]* | "tmux next-"*) pass "$tmux_v (≥ 3.2)" ;;
*) fail "tmux ≥ 3.2 (have: ${tmux_v:-none})" ;;
esac

# ── headless CLI ────────────────────────────────────────────────────────────
check "serenity help" serenity help
check "serenity doctor" serenity doctor
out=$(serenity restart 2>&1)
case "$out" in *"daemon running"*) pass "serenity restart starts the daemon" ;; *) fail "serenity restart: $out" ;; esac
check "daemon socket exists" test -S "${SERENITY_HOME:-$HOME/.local/state/serenity}/serenity.sock"

# The map, in a detached tmux pane, for a throwaway repo.
repo=$(mktemp -d)
git -C "$repo" init -q
git -C "$repo" -c user.name=smoke -c user.email=smoke@example.com commit -q --allow-empty -m init
tmux -L smoke new-session -d -s smoke -x 120 -y 40 -c "$repo" "serenity tui; echo EXITED \$?; sleep 30"
sleep 4
screen=$(tmux -L smoke capture-pane -p -t smoke 2>/dev/null)
tmux -L smoke kill-server 2>/dev/null
if [ -n "$(printf '%s' "$screen" | tr -d '[:space:]')" ] && ! printf '%s' "$screen" | grep -q "EXITED"; then
	pass "map renders in tmux"
else
	fail "map renders in tmux"
	printf '%s\n' "$screen" | sed 's/^/  │ /'
fi

out=$(serenity stop 2>&1)
case "$out" in *"daemon stopped"*) pass "serenity stop" ;; *) fail "serenity stop: $out" ;; esac

[ "$failed" -eq 0 ] && echo "── ALL PASS" || echo "── FAILED"
exit "$failed"
