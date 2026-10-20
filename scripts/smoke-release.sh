#!/bin/sh
# Tries one packaged release on this Mac before it is published. Every executable in both archives must be built for its
# archive's architecture; this Mac's rig and rigd must exit 0 printing exactly <release>+<commit>; and the release's own
# install script must install it into a throwaway RIG_ROOT and HOME, where rigd serves that build and the packaged
# dashboard answers /healthz. Whatever it installed is uninstalled however it ends. CI runs it on an Apple Silicon and an
# Intel runner, on every pull request and before a release is published.
#
#   scripts/smoke-release.sh <tag> <commit> <dist>     for example: scripts/smoke-release.sh v1.2.0 0123456789ab dist
#
# <dist> is what scripts/package-release.sh built; <commit> is the 12-character commit it was built from.
set -eu

[ $# -eq 3 ] || {
	echo "usage: scripts/smoke-release.sh <tag> <commit> <dist>" >&2
	exit 2
}
tag="$1"
commit="$2"
case "$3" in
/*) dist="$3" ;;
*) dist="$PWD/$3" ;;
esac
stamp="${tag#v}+$commit"

fail() {
	printf 'smoke test: %s\n' "$1" >&2
	exit 1
}

# Fails unless $1 --version exits 0 and prints exactly the release's stamp, with nothing else on either stream.
check_stamp() {
	code=0
	"$1" --version >"$work/stdout" 2>"$work/stderr" || code=$?
	[ "$code" -eq 0 ] || fail "$1 --version exited $code."
	[ ! -s "$work/stderr" ] || fail "$1 --version wrote to stderr: $(cat "$work/stderr")"
	printf '%s\n' "$stamp" | cmp -s - "$work/stdout" ||
		fail "$1 --version printed \"$(cat "$work/stdout")\", not exactly $stamp."
}

# Uninstalls what the install script installed, then removes the throwaway root.
finish() {
	if [ -n "${root:-}" ] && [ -x "$root/bin/rigd" ]; then
		HOME="$home" RIG_ROOT="$root" "$root/bin/rigd" uninstall >/dev/null 2>&1 ||
			printf 'smoke test: rigd uninstall failed in %s\n' "$root" >&2
	fi
	rm -rf "$work"
}

case "$(uname -m)" in
arm64) native=arm64 ;;
x86_64) native=x64 ;;
*) fail "no Rig build for $(uname -m)." ;;
esac
[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 0 ] || fail "this shell runs under Rosetta; run it natively."

# Real paths, so the Rig root is spelled as Rig resolves it.
work="$(cd "$(mktemp -d /tmp/rig-smoke.XXXXXX)" && pwd -P)"
root=""
trap finish EXIT
trap 'exit 1' HUP INT TERM

(cd "$dist" && shasum -a 256 -c SHA256SUMS >/dev/null) || fail "$dist does not match its SHA256SUMS."
for arch in arm64 x64; do
	build="rig-$tag-darwin-$arch"
	machine=arm64
	[ "$arch" = arm64 ] || machine=x86_64
	tar -xzf "$dist/$build.tar.gz" -C "$work"
	for name in rig rigd; do
		archs="$(lipo -archs "$work/$build/$name" 2>/dev/null || :)"
		[ "$archs" = "$machine" ] || fail "$build/$name is built for \"$archs\", not $machine."
	done
	[ -f "$work/$build/dashboard/web/server.js" ] || fail "$build has no dashboard/web/server.js."
done
for name in rig rigd; do
	check_stamp "$work/rig-$tag-darwin-$native/$name"
done
printf 'rig and rigd for %s report %s.\n' "$native" "$stamp"

# The install script, as a user runs it, from a copy of the release's files.
home="$work/home"
releases="$work/releases"
mkdir -p "$home" "$releases/$tag" "$work/root"
cp "$dist/rig-$tag-darwin-$native.tar.gz" "$dist/SHA256SUMS" "$releases/$tag/"
# A free port, so the dashboard never meets another Rig's on this Mac.
port="$(bun -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); process.stdout.write(String(s.port)); s.stop(true);')"
printf 'dashboard:\n  port: %s\n' "$port" >"$work/root/config.yaml"
root="$work/root"
HOME="$home" RIG_ROOT="$root" RIG_RELEASE_URL="file://$releases" sh "$dist/install" >"$work/install.log" 2>&1 ||
	fail "install failed: $(cat "$work/install.log")"
for name in rig rigd; do
	check_stamp "$root/bin/$name"
done

status="$(HOME="$home" RIG_ROOT="$root" "$root/bin/rigd" status)" || fail "rigd status failed: $status"
printf '%s\n' "$status" | grep -qxF "Version    $stamp" || fail "the installed rigd does not serve $stamp: $status"
printf '%s\n' "$status" | grep -qxF "Dashboard  http://127.0.0.1:$port" || fail "rigd serves no dashboard on port $port: $status"
# rigd starts the dashboard in the background; give it a minute to answer.
for _ in $(seq 60); do
	health="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" 2>/dev/null || :)"
	[ "$health" != ok ] || break
	sleep 1
done
[ "$health" = ok ] || fail "the dashboard did not answer /healthz on port $port within a minute: $(tail -n 20 "$root/logs/dashboard/dashboard.log" 2>/dev/null || :)"
printf 'The install script installed %s, rigd serves it, and its dashboard answers /healthz.\n' "$stamp"
