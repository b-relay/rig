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
import { upgrade, type UpgradeDependencies } from "../src/daemon/upgrade";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** A release tree on local files as GitHub serves it: `download/<tag>/{install,SHA256SUMS}` per release, and the latest
 * release's install script at `latest/download/install`. Each install script records how it was run. */
async function releases(tags: readonly string[], latest: string) {
  const home = await mkdtemp(join(tmpdir(), "rigd-upgrade-"));
  roots.push(home);
  const ran = join(home, "ran");
  const script = (tag: string, code = 0) =>
    `#!/bin/sh\nversion="${tag}"\necho "$version RIG_ROOT=$RIG_ROOT RIG_RELEASE_URL=$RIG_RELEASE_URL" >> '${ran}'\nexit ${code}\n`;
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
  await mkdir(join(home, "latest", "download"), { recursive: true });
  await writeFile(
    join(home, "latest", "download", "install"),
    await readFile(join(home, "download", latest, "install")),
  );
  const deps = (current = "0.1.0"): UpgradeDependencies => ({
    root: join(home, ".rig"),
    releases: `file://${join(home, "download")}`,
    current,
    fetch: (url) => fetch(url),
    install: (file, env) =>
      Bun.spawn(["/bin/sh", file], { env: { ...process.env, ...env } }).exited,
  });
  return {
    home,
    deps,
    publish,
    script,
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

test("rigd upgrade runs the latest release's own install script with the Rig root, and a named one to roll back", async () => {
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
  // The script downloads from the same place rigd upgrade did.
  expect(await f.ran()).toBe(
    [
      `v0.2.0 RIG_ROOT=${join(f.home, ".rig")} RIG_RELEASE_URL=file://${join(f.home, "download")}`,
      `v0.1.0 RIG_ROOT=${join(f.home, ".rig")} RIG_RELEASE_URL=file://${join(f.home, "download")}`,
      "",
    ].join("\n"),
  );
  expect(
    renderResult(
      "daemon-upgrade",
      await upgrade(f.deps(), { version: "v0.1.0" }),
    ),
  ).toBe("Rig v0.1.0 is already installed.\n");
});

test("an install script that does not match its release's SHA256SUMS never runs", async () => {
  const f = await releases(["v0.2.0"], "v0.2.0");
  // The latest install script was changed after the release.
  await writeFile(
    join(f.home, "latest", "download", "install"),
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

test("a release that does not exist, a version that is not one, an address that is not HTTPS, and a script for another release are refused before anything runs", async () => {
  const f = await releases(["v0.2.0"], "v0.2.0");
  await expect(upgrade(f.deps(), { version: "9.9.9" })).rejects.toMatchObject({
    code: "UPGRADE_DOWNLOAD",
  });
  await expect(upgrade(f.deps(), { version: "latest" })).rejects.toMatchObject({
    code: "USAGE",
  });
  await expect(
    upgrade({ ...f.deps(), releases: "http://example.com/download" }, {}),
  ).rejects.toMatchObject({ code: "UPGRADE_DOWNLOAD" });
  // v0.4.0's published script installs another release.
  await f.publish("v0.4.0", f.script("v0.2.0"));
  await expect(upgrade(f.deps(), { version: "0.4.0" })).rejects.toMatchObject({
    code: "UPGRADE_FAILED",
    message: "The install script of v0.4.0 installs v0.2.0.",
  });
  expect(await f.ran()).toBe("");
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
  await mkdir(join(home, "latest", "download"), { recursive: true });
  await writeFile(
    join(home, "latest", "download", "install"),
    await readFile(join(download, "install")),
  );
  const root = join(home, ".rig");
  const result = await upgrade(
    {
      root,
      releases: `file://${join(home, "download")}`,
      current: "0.1.0",
      fetch: (url) => fetch(url),
      install: (file, env) =>
        Bun.spawn(["/bin/sh", file], {
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, ...env },
          stdout: "ignore",
        }).exited,
    },
    {},
  );
  expect(result.outcome).toBe("upgraded");
  expect((await stat(join(root, "bin", "rigd"))).mode & 0o777).toBe(0o755);
  expect(
    await readFile(join(root, "dashboard", tag, "web", "server.js"), "utf8"),
  ).toBe("// served");
  expect(await readFile(ran, "utf8")).toBe("install\nstatus\n");
});
