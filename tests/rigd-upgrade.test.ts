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
import {
  installedRelease,
  upgrade,
  type UpgradeDependencies,
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
  const deps = (installed: string | null = "0.1.0"): UpgradeDependencies => ({
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

test("end to end, rigd upgrade installs a release through the real install script", async () => {
  const home = await mkdtemp(join(tmpdir(), "rigd-upgrade-e2e-"));
  roots.push(home);
  const tag = "v0.2.0";
  const download = join(home, "download", tag);
  await mkdir(download, { recursive: true });
  const ran = join(home, "rigd-ran");
  // A release archive per architecture, as the release workflow packs it; rigd reports serving this release.
  for (const arch of ["arm64", "x64"]) {
    const build = `rig-${tag}-darwin-${arch}`;
    const dir = join(home, "build", build);
    await mkdir(join(dir, "dashboard", "web"), { recursive: true });
    await writeFile(join(dir, "rig"), `#!/bin/sh\necho ${arch}\n`);
    await writeFile(
      join(dir, "rigd"),
      `#!/bin/sh\necho "$@" >> '${ran}'\nif [ "$1" = status ]; then echo "Version    0.2.0+test"; fi\n`,
    );
    await writeFile(join(dir, "dashboard", "web", "server.js"), "// served");
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
  const result = await upgrade(
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
      // Without RIG_ROOT, as for a default install, the script finds ~/.rig under HOME.
      install: (file, env) =>
        Bun.spawn(["/bin/sh", file], {
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, ...env },
          stdout: "ignore",
        }).exited,
    },
    {},
  );
  expect(result).toEqual({ outcome: "upgraded", release: tag, named: false });
  expect((await stat(join(root, "bin", "rigd"))).mode & 0o777).toBe(0o755);
  expect(
    await readFile(join(root, "dashboard", tag, "web", "server.js"), "utf8"),
  ).toBe("// served");
  expect(await readFile(ran, "utf8")).toBe("install\nstatus\n");
});
