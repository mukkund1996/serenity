#!/bin/sh
# Builds dist/parallel-sessions.zip: a folder holding SKILL.md, the layout
# claude.ai (Settings → Capabilities → Skills) and skill marketplaces upload.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
skills="$root/plugins/parallel-sessions/skills"
out="$root/dist/parallel-sessions.zip"

mkdir -p "$root/dist"
rm -f "$out"
(cd "$skills" && zip -qr "$out" parallel-sessions -x '*.DS_Store')
echo "$out"
