#!/bin/sh
# Builds the dashboard and assembles it into <out>, as rigd runs it: Next.js's self-contained server (web/server.js and
# the node_modules it needs) with the static files beside it. A release ships it, and the working Target runs the same
# build, so what is tried is what is shipped.
#
#   scripts/build-dashboard.sh <out>     <out> must not exist yet; run it as <bun> <out>/web/server.js
set -eu

[ $# -eq 1 ] || {
	echo "usage: scripts/build-dashboard.sh <out>" >&2
	exit 2
}
# Absolute, so it means the same directory once the script moves to the repository root.
case "$1" in
/*) out="$1" ;;
*) out="$PWD/$1" ;;
esac
[ ! -e "$out" ] || {
	echo "$out already exists; give a directory that does not exist yet." >&2
	exit 1
}
cd "$(dirname "$0")/.."

rm -rf web/.next
bun --bun next build web
mkdir -p "$out"
cp -R web/.next/standalone/. "$out/"
cp -R web/.next/static "$out/web/.next/static"
if [ -d web/public ]; then cp -R web/public "$out/web/public"; fi
# Next.js traces its image library in although no page uses next/image (images are unoptimized); it is native code
# for one architecture, so leaving it out keeps one build for both.
rm -rf "$out/node_modules/sharp" "$out/node_modules/@img"
