import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownershipRecordPath } from "../src/adapters/artifact-ownership";
import { resolveRigRoot } from "../src/cli/entry-environment";
import { installedPath } from "../src/domain/installed-path";

const TEMPLATE = join(import.meta.dir, "..", "scripts", "install");
const TAG = "v0.1.0";
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

async function run(
  args: string[],
  env: Record<string, string> = {},
  cwd?: string,
) {
  const child = Bun.spawn(args, {
    env: { PATH: SYSTEM_PATH, ...env },
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

/** A fake release on local files, as the release workflow publishes one: per architecture an archive whose `rig` says
 * which build it is and whose `rigd` records the arguments it ran with, then SHA256SUMS and the install script with the
 * tag written in. The Mac it runs on is chosen with fake `uname` and `sysctl` commands. */
async function release(
  options: {
    /** `rigd: false` leaves rigd out of the archive, `dashboard: false` the dashboard. */
    rigd?: boolean;
    dashboard?: boolean;
    /** Rewrites SHA256SUMS once it is written. */
    sums?(written: string): string;
    machine?: "arm64" | "x86_64";
    /** What `sysctl -n sysctl.proc_translated` answers: 1 under Rosetta. */
    translated?: "0" | "1";
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "rig-install-"));
  homes.push(home);
  const files = join(home, "releases", TAG);
  await mkdir(files, { recursive: true });
  const ran = join(home, "rigd-ran");
  for (const arch of ["arm64", "x64"]) {
    const build = `rig-${TAG}-darwin-${arch}`;
    const dir = join(home, "build", build);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "rig"), `#!/bin/sh\necho ${arch}\n`);
    if (options.dashboard !== false) {
      await mkdir(join(dir, "dashboard", "web"), { recursive: true });
      await writeFile(join(dir, "dashboard", "web", "server.js"), "// served");
    }
    if (options.rigd !== false)
      await writeFile(
        join(dir, "rigd"),
        // rigd status reports the release it serves: this one, unless the test says another.
        `#!/bin/sh\necho "$@" >> '${ran}'\nif [ "$1" = status ]; then echo "Version    \${RIG_TEST_SERVING:-0.1.0+test}"; exit 0; fi\necho "rigd $*"\n`,
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
  const sums = (
    await run(["sh", "-c", "shasum -a 256 rig-*.tar.gz"], {}, files)
  ).stdout;
  await writeFile(
    join(files, "SHA256SUMS"),
    options.sums ? options.sums(sums) : sums,
  );
  const script = join(home, "install");
  await writeFile(
    script,
    (await readFile(TEMPLATE, "utf8")).replace("__RIG_RELEASE__", TAG),
  );
  const fakes = join(home, "fakes");
  await mkdir(fakes);
  await writeFile(
    join(fakes, "uname"),
    `#!/bin/sh\n[ "$1" = -m ] && echo ${options.machine ?? "arm64"} || echo Darwin\n`,
  );
  await writeFile(
    join(fakes, "sysctl"),
    `#!/bin/sh\necho ${options.translated ?? "0"}\n`,
  );
  await chmod(join(fakes, "uname"), 0o755);
  await chmod(join(fakes, "sysctl"), 0o755);
  const root = join(home, ".rig");
  return {
    home,
    root,
    ran,
    script,
    install: (env: Record<string, string> = {}, path = script) =>
      run(["sh", path], {
        HOME: home,
        PATH: `${fakes}:${SYSTEM_PATH}`,
        RIG_ROOT: root,
        RIG_RELEASE_URL: `file://${join(home, "releases")}`,
        ...env,
      }),
  };
}
const installedArch = async (root: string) =>
  (await run([join(root, "bin", "rig")])).stdout.trim();

test("install puts the release's rig and rigd in the Rig root's bin, runs rigd install, and says how to reach them", async () => {
  const f = await release();
  const result = await f.install();
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    `Installed rig and rigd ${TAG} in ${f.root}/bin, and the dashboard in ${f.root}/dashboard/${TAG}.`,
  );
  // The dashboard is off PATH, under its release, for rigd to start.
  expect(
    await readFile(join(f.root, "dashboard", TAG, "web", "server.js"), "utf8"),
  ).toBe("// served");
  expect(await readdir(join(f.root, "dashboard"))).toEqual([TAG]);
  expect(result.stdout).toContain(`export PATH='${f.root}/bin':"$PATH"`);
  for (const name of ["rig", "rigd"])
    expect((await stat(join(f.root, "bin", name))).mode & 0o777).toBe(0o755);
  expect(await installedArch(f.root)).toBe("arm64");
  expect(await readFile(f.ran, "utf8")).toBe("install\nstatus\n");
  // No staging directory is left beside them.
  expect((await readdir(join(f.root, "bin"))).sort()).toEqual(["rig", "rigd"]);
  // Run again, it replaces both and says nothing about PATH once Rig is on it.
  const again = await f.install({
    PATH: `${join(f.home, "fakes")}:${f.root}/bin:${SYSTEM_PATH}`,
  });
  expect(again.code).toBe(0);
  expect(again.stdout).not.toContain("export PATH");
});

test("an Intel Mac gets the x64 build, and a shell under Rosetta on Apple Silicon the native arm64 one", async () => {
  const intel = await release({ machine: "x86_64", translated: "0" });
  expect((await intel.install()).code).toBe(0);
  expect(await installedArch(intel.root)).toBe("x64");
  const rosetta = await release({ machine: "x86_64", translated: "1" });
  expect((await rosetta.install()).code).toBe(0);
  expect(await installedArch(rosetta.root)).toBe("arm64");
});

test("without RIG_ROOT, or with it empty, Rig is installed in ~/.rig as rig itself resolves it", async () => {
  for (const RIG_ROOT of [undefined, ""]) {
    const f = await release();
    const env: Record<string, string> =
      RIG_ROOT === undefined ? {} : { RIG_ROOT };
    const result = await run(["sh", f.script], {
      HOME: f.home,
      PATH: `${join(f.home, "fakes")}:${SYSTEM_PATH}`,
      RIG_RELEASE_URL: `file://${join(f.home, "releases")}`,
      ...env,
    });
    expect(result.code).toBe(0);
    expect(resolveRigRoot(RIG_ROOT, f.home)).toBe(join(f.home, ".rig"));
    expect(await exists(join(f.home, ".rig", "bin", "rigd"))).toBe(true);
  }
});

test("a download that does not match SHA256SUMS, or a SHA256SUMS that does not name it in the canonical form once, installs nothing", async () => {
  for (const sums of [
    // Tampered: the digest is another file's.
    (written: string) => written.replace(/^[0-9a-f]{64}/gm, "0".repeat(64)),
    // A BSD-style line, which shasum -c would read as a digest of another file.
    (written: string) =>
      written.replace(
        /^[0-9a-f]{64}  (\S+)$/gm,
        `SHA256 (/etc/hosts) = ${"0".repeat(64)}  $1`,
      ),
    // Named twice.
    (written: string) => `${written}${written}`,
    // Separated by a tab, by one space, or padded.
    (written: string) => written.replace(/^([0-9a-f]{64})  /gm, "$1\t"),
    (written: string) => written.replace(/^([0-9a-f]{64})  /gm, "$1 "),
    (written: string) => written.replace(/\.tar\.gz$/gm, ".tar.gz "),
    // A valid line, and a malformed one naming the archive too.
    (written: string) =>
      `${written}${written.replace(/^([0-9a-f]{64})  /gm, "$1\t")}`,
  ]) {
    const f = await release({ sums });
    const result = await f.install();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("nothing was installed.");
    expect(await exists(join(f.root, "bin"))).toBe(false);
    expect(await exists(f.ran)).toBe(false);
  }
});

test("a release that cannot be downloaded installs nothing and names the address", async () => {
  const f = await release();
  const result = await f.install({
    RIG_RELEASE_URL: `file://${join(f.home, "nowhere")}`,
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    `could not download file://${join(f.home, "nowhere")}/${TAG}/rig-${TAG}-darwin-arm64.tar.gz`,
  );
  expect(await exists(join(f.root, "bin"))).toBe(false);
});

test("installing a release removes earlier releases' dashboards once rigd install succeeds, and keeps this release's own", async () => {
  const f = await release();
  await mkdir(join(f.root, "dashboard", "v0.0.9", "web"), { recursive: true });
  // The same release already installed may be serving: its files stay as they are.
  await mkdir(join(f.root, "dashboard", TAG, "web"), { recursive: true });
  await writeFile(
    join(f.root, "dashboard", TAG, "web", "server.js"),
    "// serving",
  );
  const result = await f.install();
  expect(result.code).toBe(0);
  expect((await readdir(join(f.root, "dashboard"))).sort()).toEqual([TAG]);
  expect(
    await readFile(join(f.root, "dashboard", TAG, "web", "server.js"), "utf8"),
  ).toBe("// serving");
});

test("when rigd install left another release serving (it adopted a running rigd), earlier dashboards are kept and the install says so", async () => {
  const f = await release();
  await mkdir(join(f.root, "dashboard", "v0.0.9", "web"), { recursive: true });
  const result = await f.install({ RIG_TEST_SERVING: "0.0.9+old" });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    `rigd serves 0.0.9+old, not ${TAG} yet, so earlier dashboards are kept; run rigd install to start this release.`,
  );
  expect((await readdir(join(f.root, "dashboard"))).sort()).toEqual([
    "v0.0.9",
    TAG,
  ]);
});

test("an archive without the dashboard installs nothing", async () => {
  const f = await release({ dashboard: false });
  const result = await f.install();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "has no dashboard/web/server.js; nothing was installed.",
  );
  expect(await exists(join(f.root, "bin"))).toBe(false);
});

test("an archive without rigd replaces neither executable", async () => {
  const f = await release({ rigd: false });
  await mkdir(join(f.root, "bin"), { recursive: true });
  await writeFile(join(f.root, "bin", "rig"), "the earlier rig");
  const result = await f.install();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`has no rigd; nothing was installed.`);
  expect(await readFile(join(f.root, "bin", "rig"), "utf8")).toBe(
    "the earlier rig",
  );
  expect(await readdir(join(f.root, "bin"))).toEqual(["rig"]);
});

test("install refuses a destination that is not a regular file, before replacing either executable", async () => {
  const f = await release();
  await mkdir(join(f.root, "bin", "rig"), { recursive: true });
  const result = await f.install();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    `${f.root}/bin/rig is not a regular file; move it aside and run install again.`,
  );
  expect(await exists(join(f.root, "bin", "rigd"))).toBe(false);
});

test("install stages nothing through a linked bin or dashboard directory, or into one others can write, and a linked root still installs", async () => {
  for (const name of ["bin", "dashboard"]) {
    const f = await release();
    const outside = join(f.home, "outside");
    await mkdir(outside);
    await mkdir(f.root, { mode: 0o700 });
    await symlink(outside, join(f.root, name));
    const result = await f.install();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `${f.root}/${name} is a symbolic link; Rig keeps its files only in real directories under its root.`,
    );
    expect(await readdir(outside)).toEqual([]);
    expect(await exists(f.ran)).toBe(false);
  }

  const open = await release();
  await mkdir(join(open.root, "bin"), { recursive: true });
  await chmod(join(open.root, "bin"), 0o775);
  const refused = await open.install();
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain(
    `${open.root}/bin can be written by other users;`,
  );
  expect(refused.stderr).toContain(`chmod 700 ${open.root}/bin`);
  expect(await readdir(join(open.root, "bin"))).toEqual([]);

  const linked = await release();
  const volume = join(linked.home, "volume");
  await mkdir(volume, { mode: 0o700 });
  await symlink(volume, linked.root);
  const installed = await linked.install();
  expect(installed.code).toBe(0);
  expect((await readdir(join(volume, "bin"))).sort()).toEqual(["rig", "rigd"]);
  expect((await stat(join(volume, "bin"))).mode & 0o777).toBe(0o700);
});

test("install never replaces a rig or rigd that a Rig Project's Target published and owns", async () => {
  const f = await release();
  // The path and record Rig itself would use for the stable Target's Tool rigd.
  const root = resolveRigRoot(f.root, f.home);
  const destination = installedPath(
    root,
    { kind: "stable", name: "stable" },
    { name: "rigd" },
  );
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(destination, "published by a Target");
  const record = ownershipRecordPath(root, destination);
  await mkdir(join(record, ".."), { recursive: true });
  await writeFile(record, "{}");
  const result = await f.install();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    `${destination} was published by a Rig Project's Target, which owns it, so install leaves it alone.`,
  );
  expect(await readFile(destination, "utf8")).toBe("published by a Target");
  expect(await exists(join(root, "bin", "rig"))).toBe(false);
  expect(await exists(f.ran)).toBe(false);
});

test("a rig a Target publishes while the release downloads is still left alone, and neither executable is replaced", async () => {
  const f = await release();
  const root = resolveRigRoot(f.root, f.home);
  const destination = installedPath(
    root,
    { kind: "stable", name: "stable" },
    { name: "rig" },
  );
  const record = ownershipRecordPath(root, destination);
  // A curl that, while the archive downloads, publishes rig as a Target does: the file and its ownership record.
  const fakes = join(f.home, "fakes");
  await writeFile(
    join(fakes, "curl"),
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
  *.tar.gz)
    mkdir -p '${join(root, "bin")}' '${join(record, "..")}'
    printf 'published by a Target' > '${destination}'
    printf '{}' > '${record}'
    ;;
  esac
done
exec /usr/bin/curl "$@"
`,
  );
  await chmod(join(fakes, "curl"), 0o755);
  const result = await f.install();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    `${destination} was published by a Rig Project's Target, which owns it, so install leaves it alone.`,
  );
  expect(await readFile(destination, "utf8")).toBe("published by a Target");
  expect(await exists(join(root, "bin", "rigd"))).toBe(false);
  // The staged copies are gone with the failure.
  expect(await readdir(join(root, "bin"))).toEqual(["rig"]);
  expect(await exists(f.ran)).toBe(false);
});

/** Publishes `bytes` at bin/<name> under `root` as `target`'s Tool would: the file and its ownership record. */
async function publish(
  root: string,
  name: string,
  bytes: string,
  target: "stable" | "working",
) {
  const destination = installedPath(
    root,
    { kind: "stable", name: "stable" },
    { name },
  );
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(destination, bytes);
  const record = ownershipRecordPath(root, destination);
  await mkdir(join(record, ".."), { recursive: true });
  await writeFile(
    record,
    JSON.stringify({
      targetId: "t1",
      componentName: name,
      project: "rig",
      target,
      revision: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  return destination;
}

test("records of other files never stop an install: a working copy's rig-dev, another stable Tool even with the same bytes, or another Tool's stale record", async () => {
  const f = await release();
  await mkdir(join(f.root, "bin"), { recursive: true });
  await writeFile(join(f.root, "bin", "rig"), "the earlier install");
  // A working copy's rig, published as rig-dev from the same bytes, and recorded as the working Target's Tool rig.
  const dev = join(f.root, "bin", "rig-dev");
  await writeFile(dev, "the earlier install");
  const record = ownershipRecordPath(f.root, dev);
  await mkdir(join(record, ".."), { recursive: true });
  await writeFile(
    record,
    JSON.stringify({
      targetId: "t2",
      componentName: "rig",
      project: "rig",
      target: "working",
      revision: createHash("sha256")
        .update("the earlier install")
        .digest("hex"),
    }),
  );
  await publish(f.root, "pantry", "another Project's Tool", "stable");
  // A stable Tool under another name whose bytes are the same as the installed rig's owns only its own file.
  await publish(f.root, "rig-old", "the earlier install", "stable");
  // An older working Target's Tool whose file is gone, as an upgraded Host keeps.
  await rm(await publish(f.root, "watch", "gone", "working"));
  const result = await f.install();
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(await installedArch(f.root)).toBe("arm64");
  expect(await readFile(dev, "utf8")).toBe("the earlier install");
});

test("a RIG_ROOT spelled with //, . or .. parts, or relative, is refused, so the owned-file check uses the path Rig records", async () => {
  const f = await release();
  for (const RIG_ROOT of [
    `${f.root}/`,
    `${f.home}//.rig`,
    `${f.home}/./.rig`,
    `${f.home}/x/../.rig`,
    "rig",
  ]) {
    const result = await f.install({ RIG_ROOT });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `RIG_ROOT must be an absolute path without //, . or .. parts, but it is "${RIG_ROOT}".`,
    );
  }
  expect(await exists(f.root)).toBe(false);
  expect(await exists(f.ran)).toBe(false);
});

test("a script cut short anywhere before its end runs nothing, even within its last line", async () => {
  const f = await release();
  const whole = await readFile(f.script, "utf8");
  const last = whole.lastIndexOf('(main "$@")');
  for (const end of [last, last + "(main".length, last + '(main "$@"'.length]) {
    const cut = join(f.home, "install-cut");
    await writeFile(cut, whole.slice(0, end));
    const result = await f.install({}, cut);
    expect(result.stdout).toBe("");
    expect(await exists(join(f.root, "bin"))).toBe(false);
    expect(await exists(f.ran)).toBe(false);
  }
});

test("the PATH line it prints means the Rig root when pasted, whatever characters the root's name holds", async () => {
  const f = await release();
  const root = join(f.home, "it's $USER");
  const result = await f.install({ RIG_ROOT: root });
  expect(result.code).toBe(0);
  const line = result.stdout
    .split("\n")
    .find((each) => each.trim().startsWith("export PATH="))!
    .trim();
  const pasted = await run(["/bin/sh", "-c", `${line}; printf '%s' "$PATH"`], {
    USER: "someone-else",
  });
  expect(pasted.stdout).toBe(`${root}/bin:${SYSTEM_PATH}`);
});

test("the install script in the repository belongs to no release and says where to get one", async () => {
  const f = await release();
  const unreleased = await f.install({}, TEMPLATE);
  expect(unreleased.code).toBe(1);
  expect(unreleased.stderr).toContain(
    "this copy of install belongs to no release.",
  );
  expect(await exists(f.ran)).toBe(false);
});

test("packaging refuses an output directory that already exists, and leaves it as it was", async () => {
  const f = await release();
  const out = join(f.home, "out");
  await mkdir(out);
  await writeFile(join(out, "keep"), "mine");
  const result = await run(
    [
      "sh",
      join(import.meta.dir, "..", "scripts", "package-release.sh"),
      TAG,
      out,
    ],
    { PATH: process.env.PATH ?? SYSTEM_PATH },
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    `${out} already exists; give a directory that does not exist yet.`,
  );
  expect(await readdir(out)).toEqual(["keep"]);
});
