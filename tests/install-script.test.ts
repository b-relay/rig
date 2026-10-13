import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMPLATE = join(import.meta.dir, "..", "scripts", "install");
const TAG = "v0.1.0";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

/** A fake release on disk, as the release workflow publishes one: an archive per architecture holding `rig` and a
 * `rigd` that records the arguments it was run with, SHA256SUMS, and the install script with the tag written in. */
async function release(options: { tamper?: boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), "rig-install-"));
  homes.push(home);
  const files = join(home, "releases", TAG);
  await mkdir(files, { recursive: true });
  const ran = join(home, "rigd-ran");
  for (const arch of ["arm64", "x64"]) {
    const build = `rig-${TAG}-darwin-${arch}`;
    const dir = join(home, "build", build);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "rig"), "#!/bin/sh\necho rig\n");
    await writeFile(
      join(dir, "rigd"),
      `#!/bin/sh\necho "$@" >> '${ran}'\necho "rigd $*"\n`,
    );
    await run([
      "tar",
      "-czf",
      join(files, `${build}.tar.gz`),
      "-C",
      join(home, "build"),
      build,
    ]);
  }
  const sums = await run(["sh", "-c", "shasum -a 256 rig-*.tar.gz"], {}, files);
  await writeFile(join(files, "SHA256SUMS"), sums.stdout);
  if (options.tamper)
    await writeFile(join(files, `rig-${TAG}-darwin-arm64.tar.gz`), "tampered");
  if (options.tamper)
    await writeFile(join(files, `rig-${TAG}-darwin-x64.tar.gz`), "tampered");
  const script = join(home, "install");
  await writeFile(
    script,
    (await readFile(TEMPLATE, "utf8")).replace("__RIG_RELEASE__", TAG),
  );
  const root = join(home, ".rig");
  return {
    home,
    root,
    ran,
    install: (env: Record<string, string> = {}) =>
      run(["sh", script], {
        HOME: home,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        RIG_ROOT: root,
        RIG_RELEASE_URL: `file://${join(home, "releases")}`,
        ...env,
      }),
  };
}
async function run(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
) {
  const child = Bun.spawn(args, {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...env },
    ...(cwd ? { cwd } : {}),
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
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

test("install puts the release's rig and rigd in the Rig root's bin, runs rigd install, and says how to reach them", async () => {
  const f = await release();
  const result = await f.install();
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    `Installed rig and rigd ${TAG} in ${f.root}/bin.`,
  );
  expect(result.stdout).toContain(`export PATH="${f.root}/bin:$PATH"`);
  for (const name of ["rig", "rigd"])
    expect((await stat(join(f.root, "bin", name))).mode & 0o777).toBe(0o755);
  expect(await readFile(f.ran, "utf8")).toBe("install\n");
  // Nothing half-written is left beside them.
  expect((await readdir(join(f.root, "bin"))).sort()).toEqual(["rig", "rigd"]);
  // Run again, it replaces both and says nothing about PATH once Rig is on it.
  const again = await f.install({
    PATH: `${f.root}/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  });
  expect(again.code).toBe(0);
  expect(again.stdout).not.toContain("export PATH");
});

test("a download that does not match SHA256SUMS installs nothing", async () => {
  const f = await release({ tamper: true });
  const result = await f.install();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "does not match the release's SHA256SUMS; nothing was installed.",
  );
  expect(await exists(join(f.root, "bin"))).toBe(false);
  expect(await exists(f.ran)).toBe(false);
});

test("install never replaces a rig or rigd that a Rig Project's Target published and owns", async () => {
  const f = await release();
  const destination = join(f.root, "bin", "rigd");
  await mkdir(join(f.root, "bin"), { recursive: true });
  await writeFile(destination, "published by a Target");
  const owners = join(f.root, "installed", "owners");
  await mkdir(owners, { recursive: true });
  // The record Rig's artifact ownership keeps, named by the SHA-256 of the executable's path.
  await writeFile(
    join(
      owners,
      `${createHash("sha256").update(destination).digest("hex")}.json`,
    ),
    "{}",
  );
  const result = await f.install();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    `${destination} was published by a Rig Project's Target, which owns it, so install leaves it alone.`,
  );
  expect(await readFile(destination, "utf8")).toBe("published by a Target");
  expect(await exists(join(f.root, "bin", "rig"))).toBe(false);
  expect(await exists(f.ran)).toBe(false);
});

test("the install script in the repository belongs to no release and says where to get one; a relative RIG_ROOT is refused", async () => {
  const f = await release();
  const unreleased = await run(["sh", TEMPLATE], {
    HOME: f.home,
    RIG_ROOT: f.root,
  });
  expect(unreleased.code).toBe(1);
  expect(unreleased.stderr).toContain(
    "this copy of install belongs to no release.",
  );
  const relative = await f.install({ RIG_ROOT: "rig" });
  expect(relative.code).toBe(1);
  expect(relative.stderr).toContain(
    'RIG_ROOT must be an absolute path, but it is "rig".',
  );
  expect(await exists(f.ran)).toBe(false);
});
