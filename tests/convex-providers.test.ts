import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/providers/command-runner";
import {
  assetName,
  createConvexReleases,
} from "../src/providers/convex-releases";
import { createDeploymentFiles } from "../src/providers/deployment-files";
import { createForegroundChildren } from "../src/providers/foreground-children";
import {
  rigdLauncher,
  rigdLauncherPath,
  writeRigdLauncher,
} from "../src/daemon/rigd-launcher";

const roots: string[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const RELEASE = "precompiled-2026-09-21-0cf49cb";
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "rig-convex-providers-"));
  roots.push(root);
  return root;
}

/** A loopback stand-in for version.convex.dev and the GitHub release downloads, serving one real zip. */
async function releaseServer(root: string, answer: unknown) {
  const staged = join(root, "staged");
  await mkdir(staged);
  await writeFile(
    join(staged, "convex-local-backend"),
    "#!/bin/sh\necho fake backend\n",
  );
  const zip = join(root, "backend.zip");
  const zipped = await runCommand({
    command: ["zip", "-q", "-j", zip, join(staged, "convex-local-backend")],
  });
  expect(zipped.exitCode).toBe(0);
  const requests: string[] = [];
  const asset = assetName(process.platform, process.arch);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/version") return Response.json(answer);
      if (path === `/download/${RELEASE}/${asset}`)
        return new Response(Bun.file(zip));
      if (path === `/download/precompiled-2026-09-22-notzip/${asset}`)
        return new Response("not a zip");
      return new Response("missing", { status: 404 });
    },
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return {
    requests,
    sources: { recommended: `${base}/version`, downloads: `${base}/download` },
  };
}

test("releases: the recommended release is read from Convex's answer, a missing binary is downloaded into Convex's cache once, and the cache lists only complete releases", async () => {
  const root = await temporary();
  const home = join(root, "home");
  const served = await releaseServer(root, { version: RELEASE });
  const releases = createConvexReleases({
    home,
    platform: process.platform,
    arch: process.arch,
    run: runCommand,
    PATH: process.env.PATH,
    fetch,
    sources: served.sources,
  });
  const signal = new AbortController().signal;
  expect(await releases.recommended(signal)).toBe(RELEASE);
  expect(await releases.cached()).toEqual([]);

  const binary = await releases.binary(RELEASE, signal);
  const cache = join(home, ".cache", "convex", "binaries");
  expect(binary).toBe(join(cache, RELEASE, "convex-local-backend"));
  const ran = await runCommand({ command: [binary] });
  expect(ran.stdout).toBe("fake backend\n");
  // Nothing of the download is left beside the cache.
  expect(await readdir(cache)).toEqual([RELEASE]);
  await releases.binary(RELEASE, signal);
  expect(
    served.requests.filter((path) => path.startsWith("/download")),
  ).toHaveLength(1);

  // A directory without its binary, and a name that is not a release, are not cached releases.
  await mkdir(join(cache, "precompiled-2026-01-01-empty"));
  await mkdir(join(cache, ".partial"));
  expect(await releases.cached()).toEqual([RELEASE]);
});

test("releases: an answer without a usable version, or no answer, recommends nothing; a release that cannot be downloaded or unpacked is a tagged error with a hint", async () => {
  const root = await temporary();
  const served = await releaseServer(root, { version: "../../etc" });
  const options = {
    home: join(root, "home"),
    platform: process.platform,
    arch: process.arch,
    run: runCommand,
    PATH: process.env.PATH,
    fetch,
    sources: served.sources,
  };
  const signal = new AbortController().signal;
  expect(
    await createConvexReleases(options).recommended(signal),
  ).toBeUndefined();
  const offline = createConvexReleases({
    ...options,
    sources: {
      recommended: "http://127.0.0.1:1/version",
      downloads: "http://127.0.0.1:1/download",
    },
  });
  expect(await offline.recommended(signal)).toBeUndefined();
  await expect(offline.binary(RELEASE, signal)).rejects.toMatchObject({
    code: "CONVEX_BACKEND_DOWNLOAD",
    hint: expect.stringContaining("--backend-version"),
  });
  const releases = createConvexReleases(options);
  await expect(
    releases.binary("precompiled-2026-01-01-gone", signal),
  ).rejects.toMatchObject({
    code: "CONVEX_BACKEND_DOWNLOAD",
    message: expect.stringContaining("HTTP 404"),
  });
  await expect(
    releases.binary("precompiled-2026-09-22-notzip", signal),
  ).rejects.toMatchObject({
    code: "CONVEX_BACKEND_DOWNLOAD",
    message: expect.stringContaining("unzip failed"),
  });
  await expect(releases.binary("../escape", signal)).rejects.toMatchObject({
    code: "CONVEX_BACKEND_DOWNLOAD",
  });
  expect(
    await readdir(join(root, "home", ".cache", "convex", "binaries")),
  ).toEqual([]);
  expect(() => assetName("win32", "x64")).toThrow(
    expect.objectContaining({ code: "CONVEX_PLATFORM" }),
  );
  expect(assetName("darwin", "arm64")).toBe(
    "convex-local-backend-aarch64-apple-darwin.zip",
  );
});

test("children: a child writes where this process does, a stop reaches it, and one that cannot start says so", async () => {
  const root = await temporary();
  const children = createForegroundChildren();
  const marker = join(root, "stopped");
  const child = children.start({
    command: [
      "/bin/sh",
      "-c",
      `trap 'echo stopped > "${marker}"; exit 0' TERM; while :; do sleep 0.05; done`,
    ],
    cwd: root,
    env: { PATH: "/usr/bin:/bin" },
  });
  await Bun.sleep(100);
  child.stop();
  expect(await child.exited).toEqual({ code: 0 });
  expect(await readFile(marker, "utf8")).toBe("stopped\n");
  child.stop();

  const missing = children.start({
    command: [join(root, "no-such-program")],
    cwd: root,
    env: {},
  });
  expect(await missing.exited).toMatchObject({
    startError: expect.stringContaining("ENOENT"),
  });
});

test("files: private files are written whole with mode 600, a missing file reads as undefined, and a copy never overwrites", async () => {
  const root = await temporary();
  const files = createDeploymentFiles();
  const path = join(root, "state", "config.json");
  expect(await files.read(path)).toBeUndefined();
  await writeFile(join(root, "loose"), "x", { mode: 0o644 });
  await files.writePrivate(path, "one");
  await files.writePrivate(join(root, "loose"), "two");
  expect(await files.read(path)).toBe("one");
  for (const written of [path, join(root, "loose")])
    expect((await Bun.file(written).stat()).mode & 0o777).toBe(0o600);
  expect(await readdir(join(root, "state"))).toEqual(["config.json"]);

  await mkdir(join(root, "from", "nested"), { recursive: true });
  await writeFile(join(root, "from", "nested", "blob"), "data");
  await files.copyDirectory(join(root, "from"), join(root, "to"));
  expect(await files.read(join(root, "to", "nested", "blob"))).toBe("data");
  await writeFile(join(root, "from", "nested", "blob"), "changed");
  await expect(
    files.copyDirectory(join(root, "from"), join(root, "to")),
  ).rejects.toThrow();
  expect(await files.read(join(root, "to", "nested", "blob"))).toBe("data");
});

test("releases: a download that breaks while its body is read is a tagged download failure and leaves nothing in the cache", async () => {
  const root = await temporary();
  const releases = createConvexReleases({
    home: join(root, "home"),
    platform: process.platform,
    arch: process.arch,
    run: runCommand,
    PATH: process.env.PATH,
    fetch: (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
      )) as unknown as typeof fetch,
  });
  await expect(
    releases.binary(RELEASE, new AbortController().signal),
  ).rejects.toMatchObject({
    code: "CONVEX_BACKEND_DOWNLOAD",
    message: expect.stringContaining("connection reset"),
  });
  expect(
    await readdir(join(root, "home", ".cache", "convex", "binaries")),
  ).toEqual([]);
});

test("the rigd launcher runs the installed rigd with its arguments, quoted, and from source keeps the workspace's .env files out", async () => {
  expect(rigdLauncher(["/Applications/Rig's Tools/rigd"])).toContain(
    `exec '/Applications/Rig'\\''s Tools/rigd' "$@"`,
  );
  const root = await temporary();
  const script = join(root, "fake-rigd.ts");
  await writeFile(
    script,
    "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), dotenv: process.env.FROM_DOTENV ?? null }));\n",
  );
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, ".env"), "FROM_DOTENV=leaked\n");
  const launcher = await writeRigdLauncher(join(root, "rig root"), [
    process.execPath,
    script,
  ]);
  expect(launcher).toBe(rigdLauncherPath(join(root, "rig root")));
  expect((await Bun.file(launcher).stat()).mode & 0o777).toBe(0o755);
  const ran = await runCommand({
    command: [launcher, "convex", "an argument"],
    cwd: workspace,
  });
  expect(JSON.parse(ran.stdout)).toEqual({
    args: ["convex", "an argument"],
    dotenv: null,
  });
  // Written again by the next rigd, whole.
  await writeRigdLauncher(join(root, "rig root"), ["/usr/local/bin/rigd"]);
  expect(await readFile(launcher, "utf8")).toContain(
    "exec '/usr/local/bin/rigd' \"$@\"",
  );
  expect(await readdir(join(root, "rig root", "daemon"))).toEqual(["rigd"]);
});

test("a launcher that cannot be written is a tagged error naming the directory", async () => {
  const root = await temporary();
  await writeFile(join(root, "daemon"), "a file where the directory belongs");
  await expect(
    writeRigdLauncher(root, ["/usr/local/bin/rigd"]),
  ).rejects.toMatchObject({
    code: "RIGD_LAUNCHER",
    hint: expect.stringContaining(join(root, "daemon")),
  });
});

test("files: a write the filesystem refuses is a tagged error naming the path", async () => {
  const root = await temporary();
  await writeFile(join(root, "blocker"), "a file where a directory belongs");
  await expect(
    createDeploymentFiles().writePrivate(
      join(root, "blocker", "config.json"),
      "{}",
    ),
  ).rejects.toMatchObject({
    code: "CONVEX_FILES",
    message: expect.stringContaining(join(root, "blocker", "config.json")),
  });
});
