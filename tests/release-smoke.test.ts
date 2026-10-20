import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// scripts/smoke-release.sh on stand-in releases: executables that are shell scripts naming their architecture, which a
// stand-in lipo reports. The install script always fails, so a release that passes the version checks is seen reaching
// the installer, unless the release is `installable`: then a stand-in installer copies rig and rigd into the root and
// serves /healthz on the dashboard's port, and the stand-in rigd reports `status` and stops that server on `uninstall`.

const SCRIPT = join(import.meta.dir, "../scripts/smoke-release.sh");
const TAG = "v1.2.3";
const COMMIT = "0123456789ab";
const STAMP = "1.2.3+0123456789ab";
const native = process.arch === "arm64" ? "arm64" : "x64";
let base: string;
let bin: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "rig-smoke-test-"));
  bin = join(base, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "lipo"),
    "#!/bin/sh\nsed -n 's/^# arch=//p' \"$2\"\n",
    {
      mode: 0o755,
    },
  );
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A shell script that prints `stdout` and `stderr` and exits with `code`, claiming to be built for `arch`. */
const executable = (arch: string, stdout: string, code = 0, stderr = "") =>
  `#!/bin/sh\n# arch=${arch}\nprintf '%s' '${stdout}'\nprintf '%s' '${stderr}' >&2\nexit ${code}\n`;
type Executable = { stdout: string; code?: number; stderr?: string };
const good: Executable = { stdout: `${STAMP}\n` };

/** Packs a stand-in release whose native rig and rigd behave as given; both archives' executables claim `claims[arch]`. */
async function release(
  executables: { rig?: Executable; rigd?: Executable } = {},
  claims: Record<"arm64" | "x64", string> = { arm64: "arm64", x64: "x86_64" },
  installable?: { readonly version: string; readonly uninstall: number },
) {
  const dist = await mkdtemp(join(base, "dist-"));
  for (const arch of ["arm64", "x64"] as const) {
    const build = `rig-${TAG}-darwin-${arch}`;
    await mkdir(join(dist, build, "dashboard", "web"), { recursive: true });
    await writeFile(join(dist, build, "dashboard", "web", "server.js"), "");
    for (const name of ["rig", "rigd"] as const) {
      const behaviour = (arch === native && executables[name]) || good;
      await writeFile(
        join(dist, build, name),
        installable && name === "rigd"
          ? standInRigd(
              claims[arch],
              installable.version,
              installable.uninstall,
            )
          : executable(
              claims[arch],
              behaviour.stdout,
              behaviour.code,
              behaviour.stderr,
            ),
        { mode: 0o755 },
      );
    }
    await Bun.$`tar -czf ${build}.tar.gz ${build} && rm -rf ${build}`
      .cwd(dist)
      .quiet();
  }
  await writeFile(
    join(dist, "install"),
    installable
      ? STAND_IN_INSTALLER
      : "#!/bin/sh\necho 'stand-in installer' >&2\nexit 1\n",
  );
  await chmod(join(dist, "install"), 0o755);
  await Bun.$`shasum -a 256 rig-*.tar.gz install > SHA256SUMS`
    .cwd(dist)
    .quiet();
  return dist;
}

/** A rigd that reports `version` serving with the dashboard on the configured port, and whose uninstall stops the
 * stand-in dashboard, records the root it uninstalled in SMOKE_LOG, and exits `uninstall`. */
const standInRigd = (arch: string, version: string, uninstall: number) =>
  `#!/bin/sh
# arch=${arch}
case "$1" in
--version) printf '%s\\n' '${STAMP}' ;;
status)
  port="$(sed -n 's/^  port: //p' "$RIG_ROOT/config.yaml")"
  printf 'Installed  yes\\nVersion    %s\\nDashboard  http://127.0.0.1:%s\\n' '${version}' "$port" ;;
uninstall)
  kill "$(cat "$RIG_ROOT/dashboard.pid")"
  printf '%s\\n' "$RIG_ROOT" >>"$SMOKE_LOG"
  echo 'stand-in uninstall refused' >&2
  exit ${uninstall} ;;
esac
`;
const STAND_IN_INSTALLER = `#!/bin/sh
set -eu
build="rig-${TAG}-darwin-${native}"
tar -xzf "\${RIG_RELEASE_URL#file://}/${TAG}/$build.tar.gz" -C "$RIG_ROOT"
mkdir -p "$RIG_ROOT/bin"
cp "$RIG_ROOT/$build/rig" "$RIG_ROOT/$build/rigd" "$RIG_ROOT/bin/"
port="$(sed -n 's/^  port: //p' "$RIG_ROOT/config.yaml")"
bun -e "Bun.serve({ hostname: '127.0.0.1', port: $port, fetch: () => new Response('ok') })" >/dev/null 2>&1 &
echo $! >"$RIG_ROOT/dashboard.pid"
`;

async function smoke(dist: string, log = join(base, "unused.log")) {
  const child = Bun.spawn(["sh", SCRIPT, TAG, COMMIT, dist], {
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      SMOKE_LOG: log,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("rig and rigd printing exactly the release and commit pass on to the install script", async () => {
  const result = await smoke(await release());
  expect(result.stdout).toContain(
    `rig and rigd for ${native} report ${STAMP}.`,
  );
  expect(result.stderr).toContain("install failed: stand-in installer");
  expect(result.code).toBe(1);
});

test("an executable that fails, or prints anything but exactly the release and commit, fails the smoke test", async () => {
  const cases: Record<
    string,
    { rig?: Executable; rigd?: Executable; error: string }
  > = {
    "rig exits 1 after the right stamp": {
      rig: { stdout: `${STAMP}\n`, code: 1 },
      error: "/rig --version exited 1.",
    },
    "rigd exits 1 after the right stamp": {
      rigd: { stdout: `${STAMP}\n`, code: 1 },
      error: "/rigd --version exited 1.",
    },
    "dots that are not dots": {
      rig: { stdout: "1x2x3+0123456789ab\n" },
      error: 'printed "1x2x3+0123456789ab", not exactly',
    },
    "another commit": {
      rigd: { stdout: "1.2.3+ba9876543210\n" },
      error: 'printed "1.2.3+ba9876543210", not exactly',
    },
    "an empty commit": {
      rig: { stdout: "1.2.3+\n" },
      error: 'printed "1.2.3+", not exactly',
    },
    "no commit": {
      rig: { stdout: "1.2.3\n" },
      error: 'printed "1.2.3", not exactly',
    },
    "a source build": {
      rig: { stdout: "1.2.3+dev\n" },
      error: 'printed "1.2.3+dev"',
    },
    "more output": {
      rigd: { stdout: `${STAMP}\nmore\n` },
      error: "not exactly 1.2.3+0123456789ab",
    },
    "a stamp that only starts like it": {
      rig: { stdout: `${STAMP}0\n` },
      error: "not exactly 1.2.3+0123456789ab",
    },
    "a warning on stderr": {
      rig: { stdout: `${STAMP}\n`, stderr: "warning" },
      error: "/rig --version wrote to stderr: warning",
    },
  };
  for (const [name, { error, ...executables }] of Object.entries(cases)) {
    const result = await smoke(await release(executables));
    expect(result.code, name).toBe(1);
    expect(result.stderr, name).toContain(error);
    expect(result.stdout, name).not.toContain("report");
  }
}, 60000);

test("an executable built for the other architecture, or files that do not match SHA256SUMS, fail the smoke test", async () => {
  const swapped = await smoke(
    await release({}, { arm64: "arm64", x64: "arm64" }),
  );
  expect(swapped.code).toBe(1);
  expect(swapped.stderr).toContain(
    `rig-${TAG}-darwin-x64/rig is built for "arm64", not x86_64.`,
  );

  const changed = await release();
  await writeFile(join(changed, "install"), "#!/bin/sh\nexit 0\n");
  const tampered = await smoke(changed);
  expect(tampered.code).toBe(1);
  expect(tampered.stderr).toContain("does not match its SHA256SUMS");
});

test("an installed release is uninstalled and its throwaway root removed, after a failure too", async () => {
  const log = join(base, "passing.log");
  const passing = await smoke(
    await release({}, undefined, { version: STAMP, uninstall: 0 }),
    log,
  );
  expect(passing.stderr).toBe("");
  expect(passing.stdout).toContain(
    `The install script installed ${STAMP}, rigd serves it, and its dashboard answers /healthz.`,
  );
  expect(passing.code).toBe(0);
  const root = (await Bun.file(log).text()).trim();
  expect(root).toEndWith("/root");
  expect(await Bun.file(join(root, "config.yaml")).exists()).toBe(false);

  const failingLog = join(base, "failing.log");
  const failing = await smoke(
    await release({}, undefined, { version: "1.2.3+other", uninstall: 0 }),
    failingLog,
  );
  expect(failing.code).toBe(1);
  expect(failing.stderr).toContain("the installed rigd does not serve");
  const failingRoot = (await Bun.file(failingLog).text()).trim();
  expect(await Bun.file(join(failingRoot, "config.yaml")).exists()).toBe(false);
}, 60000);

test("a failing uninstall fails the smoke test and keeps the root to uninstall by hand", async () => {
  const log = join(base, "refused.log");
  const result = await smoke(
    await release({}, undefined, { version: STAMP, uninstall: 1 }),
    log,
  );
  const root = (await Bun.file(log).text()).trim();
  try {
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `smoke test: rigd uninstall failed, so ${dirname(root)} is kept; uninstall it with:`,
    );
    expect(result.stderr).toContain("stand-in uninstall refused");
    expect(await Bun.file(join(root, "config.yaml")).exists()).toBe(true);
  } finally {
    await rm(dirname(root), { recursive: true, force: true });
  }
}, 60000);
