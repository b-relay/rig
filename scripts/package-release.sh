#!/bin/sh
# Builds one release's files into <out>: rig and rigd compiled for both Mac architectures, one archive per architecture,
# the install script with this release's tag written into it, and SHA256SUMS over all of them. The release workflow
# runs it on a pushed tag; it also runs locally to try a release before tagging one.
#
#   scripts/package-release.sh <tag> <out>     for example: scripts/package-release.sh v0.1.0 dist
set -eu

[ $# -eq 2 ] || {
	echo "usage: scripts/package-release.sh <tag> <out>" >&2
	exit 2
}
tag="$1"
out="$2"
cd "$(dirname "$0")/.."

# The tag names the release Rig reports, so the two can never disagree.
release="$(bun -e 'import { RIG_VERSION } from "./src/domain/version"; process.stdout.write(RIG_VERSION)')"
[ "$tag" = "v$release" ] || {
	echo "The tag $tag does not match RIG_VERSION $release in src/domain/version.ts; bump one of them." >&2
	exit 1
}
# A release is built from a committed tree, so its stamp never ends in -dirty.
[ -z "$(git status --porcelain)" ] || {
	echo "The working tree has uncommitted changes; a release is built from a commit." >&2
	exit 1
}
stamp="$(git rev-parse --short=12 HEAD)"

rm -rf "$out"
mkdir -p "$out"
for arch in arm64 x64; do
	build="rig-$tag-darwin-$arch"
	mkdir "$out/$build"
	bun build --compile --target="bun-darwin-$arch" \
		--define "process.env.RIG_BUILD_COMMIT=\"$stamp\"" \
		src/index.ts --outfile "$out/$build/rig"
	bun build --compile --target="bun-darwin-$arch" --no-compile-autoload-dotenv \
		--define "process.env.RIG_BUILD_COMMIT=\"$stamp\"" \
		src/rigd.ts --outfile "$out/$build/rigd"
	tar -czf "$out/$build.tar.gz" -C "$out" "$build"
	rm -rf "${out:?}/$build"
done
sed "s/__RIG_RELEASE__/$tag/" scripts/install >"$out/install"
(cd "$out" && shasum -a 256 rig-*.tar.gz install >SHA256SUMS)
echo "Built $tag ($release+$stamp) in $out:"
ls -l "$out"
