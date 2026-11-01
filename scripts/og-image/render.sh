#!/bin/sh
# Renders scripts/og-image/og.html to website/og.png (1200×630) with headless
# Chrome. Needs network for the Google Fonts. Override the browser with CHROME=.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out="$here/../../website/og.png"
chrome=${CHROME:-}
if [ -z "$chrome" ]; then
	for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" google-chrome chromium chromium-browser; do
		if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then chrome=$c; break; fi
	done
fi
[ -n "$chrome" ] || { echo "no Chrome found; set CHROME=/path/to/chrome" >&2; exit 1; }
"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
	--window-size=1200,630 --virtual-time-budget=8000 \
	--screenshot="$out" "file://$here/og.html" >/dev/null 2>&1
echo "wrote $(cd "$(dirname "$out")" && pwd)/og.png"
