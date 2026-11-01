#!/bin/sh
# Records the docs page's GIFs into website/docs/media and compresses them.
# Run from the repo root: sh scripts/demo/docs/record.sh [map sessions ...]
# Needs vhs and gifsicle (brew install vhs gifsicle), tmux and bun.
set -eu
cd "$(dirname "$0")/../../.."
[ $# -gt 0 ] || set -- map sessions needs-you master mentions
for name in "$@"; do
	echo "recording $name"
	vhs "scripts/demo/docs/$name.tape"
	# Clean up even if the tape stopped early.
	bun scripts/demo/demo.ts stop
	gifsicle -O3 --lossy=30 -b "website/docs/media/$name.gif"
done
ls -l website/docs/media
