import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// scripts/smoke-release.sh on stand-in releases: executables that are shell scripts naming their architecture, which a
// stand-in lipo reports, and an install script that always fails, so a release that passes the version checks is seen
// reaching the installer.

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
        executable(
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
    "#!/bin/sh\necho 'stand-in installer' >&2\nexit 1\n",
  );
  await chmod(join(dist, "install"), 0o755);
  await Bun.$`shasum -a 256 rig-*.tar.gz install > SHA256SUMS`
    .cwd(dist)
    .quiet();
  return dist;
}

async function smoke(dist: string) {
  const child = Bun.spawn(["sh", SCRIPT, TAG, COMMIT, dist], {
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
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
