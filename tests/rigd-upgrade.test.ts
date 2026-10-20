import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderResult } from "../src/cli/output";
import type { DaemonStatus } from "../src/daemon/admin";
import {
  installEnvironment,
  installationGap,
  installedRelease,
  upgrade,
  type UpgradeDependencies,
  type UpgradeRequest,
} from "../src/daemon/upgrade";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const REPOSITORY = "https://github.com/b-relay/rig";

/** A release tree on local files as GitHub serves it, `download/<tag>/{install,SHA256SUMS}` per release, with GitHub's
 * latest-release redirect answered by `fetch`. Each install script records the release and the environment it ran with. */
async function releases(tags: readonly string[], latest: string) {
  const home = await mkdtemp(join(tmpdir(), "rigd-upgrade-"));
  roots.push(home);
  const ran = join(home, "ran");
  const env: Record<string, string>[] = [];
  const script = (tag: string, code = 0) =>
    `#!/bin/sh\nversion="${tag}"\necho "$version" >> '${ran}'\nexit ${code}\n`;
  const publish = async (tag: string, body: string) => {
    const dir = join(home, "download", tag);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "install"), body);
    await writeFile(
      join(dir, "SHA256SUMS"),
      `${createHash("sha256").update(body).digest("hex")}  install\n`,
    );
  };
  for (const tag of tags) await publish(tag, script(tag));
  const deps = (
    installed: string | null = "0.1.0",
    missing?: string,
  ): UpgradeDependencies => ({
    releases: `file://${join(home, "download")}`,
    fetch: async (url) =>
      url.endsWith("/latest")
        ? new Response(null, {
            status: 302,
            headers: { location: `${REPOSITORY}/releases/tag/${latest}` },
          })
        : fetch(url, { redirect: "manual" }),
    // null: no rigd in the Rig root.
    installedRelease: async () => installed ?? undefined,
    missing: async () => missing,
    install: (file, given) => {
      env.push(given);
      return Bun.spawn(["/bin/sh", file]).exited;
    },
  });
  return {
    home,
    deps,
    publish,
    script,
    env,
    ran: () => readFile(ran, "utf8").catch(() => ""),
  };
}

test("rigd upgrade --check names a newer latest release and installs nothing; the latest is current when it is installed", async () => {
  const f = await releases(["v0.1.0", "v0.2.0"], "v0.2.0");
  const available = await upgrade(f.deps(), { check: true });
  expect(available).toEqual({
    outcome: "available",
    release: "v0.2.0",
    installed: "v0.1.0",
    named: false,
  });
  expect(renderResult("daemon-upgrade", available)).toBe(
    "Rig v0.2.0 is available; v0.1.0 is installed. Run rigd upgrade to install it.\n",
  );
  const current = await upgrade(f.deps("0.2.0"), {});
  expect(current.outcome).toBe("current");
  expect(renderResult("daemon-upgrade", current)).toBe(
    "Rig v0.2.0 is installed, the latest release.\n",
  );
  expect(await f.ran()).toBe("");
});

test("rigd upgrade runs the latest release's own install script, and a named one to roll back, leaving the Rig root to the script", async () => {
  const f = await releases(["v0.1.0", "v0.2.0"], "v0.2.0");
  const upgraded = await upgrade(f.deps(), {});
  expect(upgraded).toEqual({
    outcome: "upgraded",
    release: "v0.2.0",
    installed: "v0.1.0",
    named: false,
  });
  expect(renderResult("daemon-upgrade", upgraded)).toBe(
    "Upgraded Rig from v0.1.0 to v0.2.0.\n",
  );
  const back = await upgrade(f.deps("0.2.0"), { version: "0.1.0" });
  expect(back).toMatchObject({
    outcome: "upgraded",
    release: "v0.1.0",
    named: true,
  });
  expect(await f.ran()).toBe("v0.2.0\nv0.1.0\n");
  // The script downloads from where rigd upgrade did, and finds the Rig root as rigd does: RIG_ROOT only when it was set,
  // so a LaunchAgent or system job stays one rather than becoming a detached process.
  expect(f.env).toEqual([
    { RIG_RELEASE_URL: `file://${join(f.home, "download")}` },
    { RIG_RELEASE_URL: `file://${join(f.home, "download")}` },
  ]);
  expect(
    renderResult(
      "daemon-upgrade",
      await upgrade(f.deps(), { version: "v0.1.0" }),
    ),
  ).toBe("Rig v0.1.0 is already installed.\n");
});

test("what is installed is what the Rig root's rigd reports: an empty root installs, whatever release rigd upgrade itself is", async () => {
  const f = await releases(["v0.1.0"], "v0.1.0");
  const installed = await upgrade(f.deps(null), {});
  expect(installed).toEqual({
    outcome: "upgraded",
    release: "v0.1.0",
    named: false,
  });
  expect(renderResult("daemon-upgrade", installed)).toBe(
    "Installed Rig v0.1.0.\n",
  );
  expect(
    renderResult(
      "daemon-upgrade",
      await upgrade(f.deps(null), { check: true }),
    ),
  ).toBe(
    "Rig v0.1.0 is available; none is installed. Run rigd upgrade to install it.\n",
  );
});

test("the release decides which script runs: one serving another release's script, even a genuine earlier one, never runs", async () => {
  const f = await releases(["v0.1.0", "v0.2.0"], "v0.2.0");
  // v0.2.0's install asset is v0.1.0's script, matching v0.1.0's SHA256SUMS.
  await writeFile(
    join(f.home, "download", "v0.2.0", "install"),
    f.script("v0.1.0"),
  );
  await expect(upgrade(f.deps(), {})).rejects.toMatchObject({
    code: "UPGRADE_FAILED",
    message: "The install script of v0.2.0 installs v0.1.0.",
  });
  expect(await f.ran()).toBe("");
});

test("an install script that does not match its release's SHA256SUMS never runs", async () => {
  const f = await releases(["v0.2.0"], "v0.2.0");
  await writeFile(
    join(f.home, "download", "v0.2.0", "install"),
    f.script("v0.2.0").replace("exit 0", "echo changed; exit 0"),
  );
  await expect(upgrade(f.deps(), {})).rejects.toMatchObject({
    code: "UPGRADE_FAILED",
    message: "The install script of v0.2.0 does not match its SHA256SUMS.",
  });
  expect(await f.ran()).toBe("");
});

test("a failed install script fails the upgrade, naming its exit", async () => {
  const f = await releases(["v0.2.0"], "v0.2.0");
  await f.publish("v0.3.0", f.script("v0.3.0", 4));
  await expect(upgrade(f.deps(), { version: "0.3.0" })).rejects.toMatchObject({
    code: "UPGRADE_FAILED",
    message: "Installing v0.3.0 failed; its install script exited with code 4.",
  });
});

test("a release that does not exist, a version that is not one, and no release at all are refused before anything runs", async () => {
  const f = await releases(["v0.2.0"], "v0.2.0");
  await expect(upgrade(f.deps(), { version: "9.9.9" })).rejects.toMatchObject({
    code: "UPGRADE_DOWNLOAD",
  });
  // --check too: a release that does not exist is never said to be available.
  await expect(
    upgrade(f.deps(), { version: "9.9.9", check: true }),
  ).rejects.toMatchObject({ code: "UPGRADE_DOWNLOAD" });
  await expect(upgrade(f.deps(), { version: "latest" })).rejects.toMatchObject({
    code: "USAGE",
  });
  await expect(
    upgrade(
      {
        ...f.deps(),
        fetch: async () => new Response("Not Found", { status: 404 }),
      },
      {},
    ),
  ).rejects.toMatchObject({
    code: "UPGRADE_DOWNLOAD",
    message: "There is no release of Rig yet.",
  });
  expect(await f.ran()).toBe("");
});

test("every redirect is followed by rigd upgrade itself and must stay on HTTPS, within a bound", async () => {
  const body = `#!/bin/sh\nversion="v0.2.0"\nexit 0\n`;
  const sums = `${createHash("sha256").update(body).digest("hex")}  install\n`;
  const ran: string[] = [];
  /** GitHub's shape: a release asset redirects once to its CDN; `hops` decides each address's answer. */
  const deps = (
    hops: Record<string, Response | (() => Response)>,
  ): UpgradeDependencies => ({
    releases: `${REPOSITORY}/releases/download`,
    fetch: async (url) => {
      const answer = hops[url];
      if (!answer) return new Response("Not Found", { status: 404 });
      return typeof answer === "function" ? answer() : answer.clone();
    },
    installedRelease: async () => "0.1.0",
    missing: async () => undefined,
    install: async (file) => {
      ran.push(file);
      return 0;
    },
  });
  const redirect = (location: string) => () =>
    new Response(null, { status: 302, headers: { location } });
  const github = {
    [`${REPOSITORY}/releases/latest`]: redirect(
      `${REPOSITORY}/releases/tag/v0.2.0`,
    ),
    [`${REPOSITORY}/releases/download/v0.2.0/install`]: redirect(
      "https://objects.example.com/install",
    ),
    "https://objects.example.com/install": () => new Response(body),
    [`${REPOSITORY}/releases/download/v0.2.0/SHA256SUMS`]: redirect(
      "https://objects.example.com/sums",
    ),
    "https://objects.example.com/sums": () => new Response(sums),
  };
  expect(await upgrade(deps(github), {})).toMatchObject({
    outcome: "upgraded",
  });
  expect(ran).toHaveLength(1);
  // An HTTP hop anywhere in the chain, even one that comes back to HTTPS, is refused.
  await expect(
    upgrade(
      deps({
        ...github,
        "https://objects.example.com/install": redirect(
          "http://cache.example.com/install",
        ),
        "http://cache.example.com/install": redirect(
          "https://objects.example.com/install-2",
        ),
        "https://objects.example.com/install-2": () => new Response(body),
      }),
      {},
    ),
  ).rejects.toMatchObject({
    code: "UPGRADE_DOWNLOAD",
    message:
      "Could not download http://cache.example.com/install: it is not HTTPS.",
  });
  // An HTTPS download never ends in a local file.
  await expect(
    upgrade(
      deps({
        ...github,
        "https://objects.example.com/install": redirect("file:///etc/hosts"),
      }),
      {},
    ),
  ).rejects.toMatchObject({
    code: "UPGRADE_DOWNLOAD",
    message: "Could not download file:///etc/hosts: it is not HTTPS.",
  });
  // A redirect to an address that is not one is a failed download.
  await expect(
    upgrade(
      deps({
        ...github,
        "https://objects.example.com/install": redirect("https://"),
      }),
      {},
    ),
  ).rejects.toMatchObject({
    code: "UPGRADE_DOWNLOAD",
    message: expect.stringContaining("named no valid address"),
  });
  // A redirect loop ends.
  await expect(
    upgrade(
      deps({
        ...github,
        "https://objects.example.com/install": redirect(
          "https://objects.example.com/install",
        ),
      }),
      {},
    ),
  ).rejects.toMatchObject({ code: "UPGRADE_DOWNLOAD" });
  expect(ran).toHaveLength(1);
});

test("the installed release is read from the Rig root's rigd version, and is none when there is no rigd there", async () => {
  const home = await mkdtemp(join(tmpdir(), "rigd-installed-"));
  roots.push(home);
  const rigd = join(home, "rigd");
  await writeFile(rigd, "#!/bin/sh\necho 0.1.0+abcdef123456\n");
  await chmod(rigd, 0o755);
  expect(await installedRelease(rigd)).toBe("0.1.0");
  await writeFile(rigd, "#!/bin/sh\necho 0.1.0+dev\n");
  expect(await installedRelease(rigd)).toBe("0.1.0");
  expect(await installedRelease(join(home, "missing"))).toBeUndefined();
});

/** A release on local files built as the release workflow builds one, with the real install script, whose fake `rigd` is
 * `rigd` (a shell script body) and whose `rig` reports the release. `upgrade` runs rigd upgrade against it without RIG_ROOT,
 * as for a default install, so the script finds ~/.rig under HOME. */
async function scriptRelease(tag: string, rigd: (ran: string) => string) {
  const home = await mkdtemp(join(tmpdir(), "rigd-upgrade-e2e-"));
  roots.push(home);
  const download = join(home, "download", tag);
  await mkdir(download, { recursive: true });
  const ran = join(home, "rigd-ran");
  for (const arch of ["arm64", "x64"]) {
    const build = `rig-${tag}-darwin-${arch}`;
    const dir = join(home, "build", build);
    await mkdir(join(dir, "dashboard", "web"), { recursive: true });
    await writeFile(
      join(dir, "rig"),
      `#!/bin/sh\n[ "$1" = --version ] && echo ${tag.slice(1)}+test || echo ${arch}\n`,
    );
    await writeFile(join(dir, "rigd"), rigd(ran));
    await writeFile(join(dir, "dashboard", "web", "server.js"), "// served");
    await mkdir(join(dir, "dashboard", "web", "node_modules", "dep"), {
      recursive: true,
    });
    await writeFile(
      join(dir, "dashboard", "web", "node_modules", "dep", "index.js"),
      "// dependency",
    );
    await chmod(join(dir, "rig"), 0o755);
    await chmod(join(dir, "rigd"), 0o755);
    const tar = Bun.spawn([
      "tar",
      "-czf",
      join(download, `${build}.tar.gz`),
      "-C",
      join(home, "build"),
      build,
    ]);
    expect(await tar.exited).toBe(0);
  }
  await writeFile(
    join(download, "install"),
    (
      await readFile(join(import.meta.dir, "..", "scripts", "install"), "utf8")
    ).replace("__RIG_RELEASE__", tag),
  );
  const sums = Bun.spawn(["sh", "-c", "shasum -a 256 rig-*.tar.gz install"], {
    cwd: download,
    stdout: "pipe",
  });
  await writeFile(
    join(download, "SHA256SUMS"),
    await new Response(sums.stdout).text(),
  );
  const root = join(home, ".rig");
  return {
    home,
    root,
    ran,
    upgrade: (
      missing: UpgradeDependencies["missing"],
      request: UpgradeRequest = {},
    ) =>
      upgrade(
        {
          releases: `file://${join(home, "download")}`,
          fetch: async (url) =>
            url.endsWith("/latest")
              ? new Response(null, {
                  status: 302,
                  headers: { location: `${REPOSITORY}/releases/tag/${tag}` },
                })
              : fetch(url, { redirect: "manual" }),
          installedRelease: () => installedRelease(join(root, "bin", "rigd")),
          missing,
          install: (file, env) =>
            Bun.spawn(["/bin/sh", file], {
              env: {
                PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
                HOME: home,
                ...env,
              },
              stdout: "ignore",
              stderr: "ignore",
            }).exited,
        },
        request,
      ),
  };
}

test("end to end, rigd upgrade installs a release through the real install script", async () => {
  const tag = "v0.2.0";
  // rigd reports serving this release.
  const f = await scriptRelease(
    tag,
    (ran) =>
      `#!/bin/sh\necho "$@" >> '${ran}'\nif [ "$1" = status ]; then echo "Version    0.2.0+test"; fi\n`,
  );
  const result = await f.upgrade(async () => undefined);
  expect(result).toEqual({ outcome: "upgraded", release: tag, named: false });
  expect((await stat(join(f.root, "bin", "rigd"))).mode & 0o777).toBe(0o755);
  expect(
    await readFile(join(f.root, "dashboard", tag, "web", "server.js"), "utf8"),
  ).toBe("// served");
  expect(await readFile(f.ran, "utf8")).toBe("install\nstatus\n");
});

test("an upgrade whose rigd install failed after rigd was replaced is installed again by the same upgrade, not taken as current", async () => {
  const tag = "v0.2.0";
  // rigd install fails while Host config is invalid (the file `invalid` exists), and otherwise records rigd installed.
  const f = await scriptRelease(
    tag,
    (ran) =>
      `#!/bin/sh\n[ "$1" = --version ] && { echo 0.2.0+test; exit 0; }\n` +
      `echo "$@" >> '${ran}'\n` +
      `if [ "$1" = install ]; then [ -e "$HOME/invalid" ] && exit 1; touch "$HOME/installed"; fi\n` +
      `if [ "$1" = status ]; then echo "Version    0.2.0+test"; fi\n`,
  );
  // What rigd status would say: installed and serving this release once the fake rigd install has run.
  const status = async (): Promise<DaemonStatus> => {
    const installed = await stat(join(f.home, "installed")).then(
      () => true,
      () => false,
    );
    return {
      installed,
      running: installed,
      reachable: installed,
      ...(installed ? { version: "0.2.0+test" } : {}),
    };
  };
  const missing = (release: string) => installationGap(f.root, release, status);
  await writeFile(join(f.home, "invalid"), "");
  await expect(f.upgrade(missing)).rejects.toMatchObject({
    code: "UPGRADE_FAILED",
  });
  // rig and rigd of the release are in place; rigd is not installed.
  expect(await installedRelease(join(f.root, "bin", "rigd"))).toBe("0.2.0");
  expect(await missing(tag)).toBe("rigd is not installed");
  // Host config corrected, the same upgrade completes the installation.
  await rm(join(f.home, "invalid"));
  const completed = await f.upgrade(missing);
  expect(completed).toEqual({
    outcome: "completed",
    release: tag,
    installed: tag,
    named: false,
    missing: "rigd is not installed",
  });
  expect(renderResult("daemon-upgrade", completed)).toBe(
    "Installed Rig v0.2.0 again, since it was incomplete (rigd is not installed).\n",
  );
  expect(await readFile(f.ran, "utf8")).toBe("install\ninstall\nstatus\n");
  // Now complete, the next upgrade is current and runs nothing.
  expect((await f.upgrade(missing)).outcome).toBe("current");
  expect(await readFile(f.ran, "utf8")).toBe("install\ninstall\nstatus\n");
  // A runtime dependency of the dashboard lost while its server stays: --check says so, and the upgrade puts it back.
  const dependency = join(
    f.root,
    "dashboard",
    tag,
    "web",
    "node_modules",
    "dep",
    "index.js",
  );
  await rm(dependency);
  expect(await f.upgrade(missing, { check: true })).toMatchObject({
    outcome: "incomplete",
    missing: `its dashboard has no ${dependency}`,
  });
  expect(await f.upgrade(missing)).toMatchObject({ outcome: "completed" });
  expect(await readFile(dependency, "utf8")).toBe("// dependency");
  expect(await missing(tag)).toBeUndefined();
});

test("a release whose rigd is installed is complete only with rig of that release, every file of its dashboard, and rigd installed and serving it", async () => {
  const home = await mkdtemp(join(tmpdir(), "rigd-gap-"));
  roots.push(home);
  const tag = "v0.2.0";
  const serving: DaemonStatus = {
    installed: true,
    running: true,
    reachable: true,
    version: "0.2.0+test",
  };
  let status = serving;
  const gap = () => installationGap(home, tag, async () => status);
  expect(await gap()).toBe(`rig in ${join(home, "bin")} is not ${tag}`);
  await mkdir(join(home, "bin"));
  await writeFile(join(home, "bin", "rig"), "#!/bin/sh\necho 0.1.0+test\n");
  await chmod(join(home, "bin", "rig"), 0o755);
  expect(await gap()).toBe(`rig in ${join(home, "bin")} is not ${tag}`);
  await writeFile(join(home, "bin", "rig"), "#!/bin/sh\necho 0.2.0+test\n");
  const dashboard = join(home, "dashboard", tag);
  const list = join(dashboard, "files.sha256");
  const server = join(dashboard, "web", "server.js");
  const dependency = join(dashboard, "web", "node_modules", "dep", "index.js");
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  await mkdir(join(dashboard, "web", "node_modules", "dep"), {
    recursive: true,
  });
  await writeFile(server, "// served");
  await writeFile(dependency, "// dependency");
  // Without the list the install script writes, the dashboard cannot be checked.
  expect(await gap()).toBe(`its dashboard has no file list at ${list}`);
  await writeFile(
    list,
    `${sha("// served")}  ./web/server.js\n${sha("// dependency")}  ./web/node_modules/dep/index.js\n`,
  );
  expect(await gap()).toBeUndefined();
  // A runtime dependency missing, or changed, while the server is still there.
  await rm(dependency);
  expect(await gap()).toBe(`its dashboard has no ${dependency}`);
  await writeFile(dependency, "// edited");
  expect(await gap()).toBe(`its dashboard's ${dependency} is not as released`);
  await writeFile(dependency, "// dependency");
  // A file the dashboard wrote itself does not count; a list that names a path outside it is no list.
  await writeFile(join(dashboard, "web", "cache"), "written while serving");
  expect(await gap()).toBeUndefined();
  await writeFile(list, `${sha("x")}  ./../outside\n`);
  expect(await gap()).toBe(`its dashboard has no file list at ${list}`);
  await writeFile(
    list,
    `${sha("// served")}  ./web/server.js\n${sha("// dependency")}  ./web/node_modules/dep/index.js\n`,
  );
  expect(await gap()).toBeUndefined();
  status = { installed: false, running: false, reachable: false };
  expect(await gap()).toBe("rigd is not installed");
  status = { installed: true, running: false, reachable: false };
  expect(await gap()).toBe("rigd is not running");
  status = { ...serving, version: "0.1.0+test" };
  expect(await gap()).toBe("rigd 0.1.0+test is serving");
  // --check says so, and installs nothing.
  const f = await releases([tag], tag);
  const incomplete = await upgrade(f.deps("0.2.0", "rigd is not running"), {
    check: true,
  });
  expect(incomplete).toEqual({
    outcome: "incomplete",
    release: tag,
    installed: tag,
    named: false,
    missing: "rigd is not running",
  });
  expect(renderResult("daemon-upgrade", incomplete)).toBe(
    "Rig v0.2.0 is installed but incomplete: rigd is not running. Run rigd upgrade to complete it.\n",
  );
  expect(await f.ran()).toBe("");
});

test("the install script gets RIG_ROOT as rigd resolved it when one was set, and none otherwise", () => {
  expect(
    installEnvironment({ PATH: "/bin", RIG_ROOT: "/tmp/root/" }, "/tmp/root"),
  ).toEqual({ PATH: "/bin", RIG_ROOT: "/tmp/root" });
  for (const RIG_ROOT of [undefined, ""])
    expect(
      installEnvironment({ PATH: "/bin", RIG_ROOT }, "/Users/me/.rig"),
    ).toEqual({ PATH: "/bin" });
});
