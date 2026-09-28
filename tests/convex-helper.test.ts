import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The helper script convex@2 writes into a Project, tested through its exported functions with fakes for the download,
// the processes and the clock over real temporary files. tests/convex-script.test.ts runs it as a process.
import {
  backendArguments,
  deploymentStore,
  HelperError,
  newDeploymentRelease,
  nextRelease,
  readSettings,
  runDeployment,
  selfHostedEnvFile,
  type ChildExit,
  type ConvexRunRequest,
  type Dependencies,
  type RunningChild,
} from "../src/recipes/files/rig-convex";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const OLD = "precompiled-2026-01-30-8c5259d";
const NEW = "precompiled-2026-09-21-0cf49cb";

interface FakeChild extends RunningChild {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  stopped: boolean;
  killed?: boolean;
  end(exit: ChildExit): void;
}
/** Fakes for the download, the children and the clock, over real files in a temporary workspace and state directory. */
async function harness(
  options: {
    recommended?: string;
    cached?: string[];
    /** Releases that cannot be obtained. */
    unavailable?: string[];
    /** What the backend answers at /instance_name once it has started; its deployment name by default. */
    answer?: (name: string) => string | undefined;
    keygen?: { exitCode: number; stdout: string; stderr: string };
    /** How the backend ends as soon as it is started. */
    backendEnds?: ChildExit;
    /** A stop arrives while keygen runs, which then fails as a cancelled command does. */
    stopDuringKeygen?: boolean;
    /** Releases whose download breaks with an error that is not a HelperError. */
    broken?: string[];
    /** The backend ignores SIGTERM; only a kill ends it. */
    backendIgnoresStop?: boolean;
    /** What already answers at /instance_name before any backend was started. */
    occupied?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "rig-convex-helper-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const stateDir = join(root, "data", "convex", "backend");
  await mkdir(workspace);
  const children: FakeChild[] = [];
  const events: string[] = [];
  let out = "";
  let err = "";
  const deps: Dependencies = {
    releases: {
      async recommended() {
        events.push("recommended");
        return options.recommended;
      },
      async cached() {
        return options.cached ?? [];
      },
      async binary(release) {
        events.push(`binary ${release}`);
        if (options.broken?.includes(release))
          throw new Error("ECONNRESET while reading the body");
        if (options.unavailable?.includes(release))
          throw new HelperError(
            "CONVEX_BACKEND_DOWNLOAD",
            `Convex backend ${release} could not be downloaded (offline).`,
            "Connect.",
          );
        return `/cache/${release}/convex-local-backend`;
      },
    },
    children: {
      start({ command, cwd, env }) {
        let settle!: (exit: ChildExit) => void;
        const exited = new Promise<ChildExit>((resolve) => (settle = resolve));
        let ended = false;
        const child: FakeChild = {
          command,
          cwd,
          env,
          exited,
          stopped: false,
          end(exit) {
            if (ended) return;
            ended = true;
            settle(exit);
          },
          stop() {
            if (ended) return;
            child.stopped = true;
            if (!(options.backendIgnoresStop && child === children[0]))
              child.end({ signal: "SIGTERM" });
          },
          kill() {
            child.killed = true;
            child.end({ signal: "SIGKILL" });
          },
        };
        children.push(child);
        if (children.length === 1 && options.backendEnds)
          child.end(options.backendEnds);
        return child;
      },
    },
    files: deploymentStore(),
    async run(request) {
      events.push(`run ${request.command.slice(1).join(" ")}`);
      if (options.stopDuringKeygen) {
        stop.abort();
        throw new HelperError("COMMAND_CANCELLED", "Cancelled.", "Retry.");
      }
      return (
        options.keygen ?? {
          exitCode: 0,
          stdout: `${request.command[4]}|admin-key\n`,
          stderr: "",
        }
      );
    },
    async probe(url) {
      const backend = children[0];
      if (url !== `http://127.0.0.1:47001/instance_name`) return undefined;
      if (!backend) return options.occupied;
      const name =
        backend.command[backend.command.indexOf("--instance-name") + 1]!;
      return (options.answer ?? ((own) => own))(name);
    },
    async wait() {
      // Time passes at once, but a timer already due (a signal the test schedules) runs first.
      clock += 250;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    now: () => clock,
    newInstanceSecret: () => "f".repeat(64),
    output: {
      write: (text) => void (out += text),
      error: (text) => void (err += text),
    },
  };
  let clock = 0;
  const request: ConvexRunRequest = {
    cloudPort: 47001,
    sitePort: 47002,
    stateDir,
    workspace,
    instanceName: "convex-self-hosted",
    devArguments: ["--typecheck", "disable"],
    environment: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/operator",
      TZ: "America/New_York",
      CONVEX_DEPLOYMENT: "anonymous:anonymous-app",
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:1",
    },
  };
  const stop = new AbortController();
  /** Runs the helper; `during` is called once convex dev has started, and the helper is stopped after it unless it ended. */
  const start = (
    overrides: Partial<ConvexRunRequest> = {},
    during: (both: { backend: FakeChild; dev: FakeChild }) => void = () =>
      stop.abort(),
  ) => {
    const result = runDeployment(
      { ...request, ...overrides },
      deps,
      stop.signal,
    );
    void (async () => {
      for (let turn = 0; turn < 1000 && children.length < 2; turn++)
        await Bun.sleep(1);
      if (children.length === 2)
        during({ backend: children[0]!, dev: children[1]! });
    })();
    return result;
  };
  return {
    root,
    workspace,
    stateDir,
    children,
    events,
    stop,
    start,
    output: () => ({ out, err }),
  };
}

test("a first start creates the deployment in the state directory, points .env.local at a loopback backend, runs convex dev against it, and a stop ends both", async () => {
  const h = await harness({ recommended: NEW });
  await writeFile(
    join(h.workspace, ".env.local"),
    "# Deployment used by `npx convex dev`\nCONVEX_DEPLOYMENT=dev:cloud-app # team: x\n\nVITE_CONVEX_URL=http://127.0.0.1:3210\nexport CONVEX_DEPLOY_KEY=prod:app|key\nAPP_KEY=keep\n",
  );
  expect(await h.start()).toBe(0);

  const config = JSON.parse(
    await readFile(join(h.stateDir, "config.json"), "utf8"),
  );
  expect(config).toEqual({
    deploymentName: "convex-self-hosted",
    backendVersion: NEW,
    adminKey: "convex-self-hosted|admin-key",
    instanceSecret: "f".repeat(64),
  });
  expect((await stat(join(h.stateDir, "config.json"))).mode & 0o777).toBe(
    0o600,
  );
  expect(h.events).toEqual([
    "recommended",
    `binary ${NEW}`,
    `run keygen admin-key --instance-name convex-self-hosted --instance-secret ${"f".repeat(64)}`,
    `binary ${NEW}`,
  ]);
  const [backend, dev] = h.children;
  expect(backend!.command).toEqual([
    `/cache/${NEW}/convex-local-backend`,
    "--interface",
    "127.0.0.1",
    "--port",
    "47001",
    "--site-proxy-port",
    "47002",
    "--instance-name",
    "convex-self-hosted",
    "--instance-secret",
    "f".repeat(64),
    "--local-storage",
    join(h.stateDir, "convex_local_storage"),
    "--disable-beacon",
    join(h.stateDir, "convex_local_backend.sqlite3"),
  ]);
  expect(backend!.env.RUST_LOG).toBe("warn");
  // The backend panics when TZ is set; convex dev keeps the operator's.
  expect(backend!.env.TZ).toBeUndefined();
  expect(backend!.env.HOME).toBe("/home/operator");
  expect(dev!.command).toEqual([
    "bunx",
    "convex",
    "dev",
    "--typecheck",
    "disable",
  ]);
  expect(dev!.cwd).toBe(h.workspace);
  expect(dev!.env).toMatchObject({
    PATH: "/usr/bin:/bin",
    TZ: "America/New_York",
    CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:47001",
    CONVEX_SELF_HOSTED_ADMIN_KEY: "convex-self-hosted|admin-key",
  });
  // Set empty, so neither the Service's environment nor a dotenv file can pick another deployment.
  for (const key of [
    "CONVEX_DEPLOYMENT",
    "CONVEX_DEPLOY_KEY",
    "CONVEX_DEPLOYMENT_TOKEN",
  ])
    expect(dev!.env[key]).toBe("");
  expect(backend!.stopped && dev!.stopped).toBe(true);
  expect(await readFile(join(h.workspace, ".env.local"), "utf8")).toBe(
    "# Deployment used by `npx convex dev`\n# CONVEX_DEPLOYMENT=dev:cloud-app # team: x  # set aside by rig-convex.ts\n\nVITE_CONVEX_URL=http://127.0.0.1:3210\n# export CONVEX_DEPLOY_KEY=prod:app|key  # set aside by rig-convex.ts\nAPP_KEY=keep\n\n# Convex backend run by scripts/rig-convex.ts\nCONVEX_SELF_HOSTED_URL=http://127.0.0.1:47001\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|admin-key\n",
  );
  expect(h.output().out).toContain(
    `Created Convex deployment convex-self-hosted (backend ${NEW}) in ${h.stateDir}`,
  );
  expect(h.output().out).toContain(
    `Convex backend convex-self-hosted (${NEW}) is up at http://127.0.0.1:47001`,
  );
});

test("an existing deployment moves to a newer recommended release once its backend is up, and stays on its own when the newer one cannot be obtained", async () => {
  const deployment = {
    deploymentName: "anonymous-app",
    backendVersion: OLD,
    adminKey: "anonymous-app|key",
    instanceSecret: "abc",
    ports: { cloud: 3210, site: 3211 },
  };
  const upgrading = await harness({ recommended: NEW });
  await mkdir(upgrading.stateDir, { recursive: true });
  await writeFile(
    join(upgrading.stateDir, "config.json"),
    JSON.stringify(deployment),
  );
  expect(await upgrading.start()).toBe(0);
  expect(upgrading.events).toEqual(["recommended", `binary ${NEW}`]);
  expect(upgrading.children[0]!.command[0]).toBe(
    `/cache/${NEW}/convex-local-backend`,
  );
  // Fields Rig does not use are kept; only the release changes.
  expect(
    JSON.parse(await readFile(join(upgrading.stateDir, "config.json"), "utf8")),
  ).toEqual({ ...deployment, backendVersion: NEW });
  expect(upgrading.output().out).toContain(
    `Moved the Convex deployment from backend ${OLD} to ${NEW}`,
  );

  // Any failure to get the newer release falls back, not only a tagged one.
  const offline = await harness({ recommended: NEW, broken: [NEW] });
  await mkdir(offline.stateDir, { recursive: true });
  await writeFile(
    join(offline.stateDir, "config.json"),
    JSON.stringify(deployment),
  );
  expect(await offline.start()).toBe(0);
  expect(offline.children[0]!.command[0]).toBe(
    `/cache/${OLD}/convex-local-backend`,
  );
  expect(offline.output().err).toContain(
    `Staying on Convex backend ${OLD}: ECONNRESET while reading the body`,
  );
  expect(
    JSON.parse(await readFile(join(offline.stateDir, "config.json"), "utf8"))
      .backendVersion,
  ).toBe(OLD);
});

test("a deployment convex dev --local left in the workspace is copied into the state directory and the original is left in place", async () => {
  const h = await harness({ recommended: NEW });
  const local = join(h.workspace, ".convex", "local", "default");
  await mkdir(join(local, "convex_local_storage"), { recursive: true });
  const config = JSON.stringify({
    deploymentName: "anonymous-app",
    backendVersion: NEW,
    adminKey: "anonymous-app|key",
    instanceSecret: "abc",
  });
  await writeFile(join(local, "config.json"), config, { mode: 0o644 });
  await chmod(local, 0o755);
  await writeFile(join(local, "convex_local_backend.sqlite3"), "rows");
  await writeFile(join(local, "convex_local_storage", "blob"), "file");

  expect(await h.start()).toBe(0);
  expect(
    await readFile(join(h.stateDir, "convex_local_backend.sqlite3"), "utf8"),
  ).toBe("rows");
  expect(
    await readFile(join(h.stateDir, "convex_local_storage", "blob"), "utf8"),
  ).toBe("file");
  expect(await readFile(join(local, "config.json"), "utf8")).toBe(config);
  // The copy's secrets are private, whatever the source's modes were.
  expect((await stat(h.stateDir)).mode & 0o777).toBe(0o700);
  expect((await stat(join(h.stateDir, "config.json"))).mode & 0o777).toBe(
    0o600,
  );
  expect(await readFile(join(h.stateDir, "config.json"), "utf8")).toBe(config);
  expect(h.children[0]!.command).toContain("anonymous-app");
  expect(h.events).not.toContain(expect.stringMatching(/^run /));
  expect(h.output().out).toContain(
    `Copied the Convex deployment anonymous-app from ${local} to ${h.stateDir}; the original is left in place.`,
  );
});

test("offline, a new deployment starts on the newest cached release, and fails before starting anything when there is none", async () => {
  const cached = await harness({
    cached: [OLD, NEW, "precompiled-2026-04-13-8c2143a"],
  });
  expect(await cached.start()).toBe(0);
  expect(cached.events.slice(0, 2)).toEqual(["recommended", `binary ${NEW}`]);

  const empty = await harness();
  const failure = await empty.start().catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: "CONVEX_BACKEND_UNAVAILABLE",
    hint: expect.stringContaining("CONVEX_BACKEND_VERSION"),
  });
  expect(empty.children).toEqual([]);
  expect(await empty.output().err).toBe("");
});

test("a pinned release is run as asked without asking Convex, and a pin older than the deployment is warned about", async () => {
  const h = await harness({ recommended: NEW });
  await mkdir(h.stateDir, { recursive: true });
  await writeFile(
    join(h.stateDir, "config.json"),
    JSON.stringify({
      deploymentName: "app",
      backendVersion: NEW,
      adminKey: "k",
      instanceSecret: "s",
    }),
  );
  expect(await h.start({ pinnedRelease: OLD })).toBe(0);
  expect(h.events).toEqual([`binary ${OLD}`]);
  expect(h.output().err).toContain(
    `Moving the deployment from Convex backend ${NEW} back to ${OLD}`,
  );
});

test("when one child ends by itself the other is stopped and its exit code is the Service's; a backend that dies while starting starts no convex dev", async () => {
  const devFails = await harness({ recommended: NEW });
  expect(await devFails.start({}, ({ dev }) => dev.end({ code: 2 }))).toBe(2);
  expect(devFails.children[0]!.stopped).toBe(true);
  expect(devFails.output().err).toContain(
    "convex dev exited with code 2; stopping the Convex Service.",
  );

  const backendClean = await harness({ recommended: NEW });
  expect(
    await backendClean.start({}, ({ backend }) => backend.end({ code: 0 })),
  ).toBe(1);
  expect(backendClean.children[1]!.stopped).toBe(true);

  const neverUp = await harness({
    recommended: NEW,
    answer: () => undefined,
    backendEnds: { startError: "spawn ENOENT" },
  });
  expect(await neverUp.start()).toBe(1);
  expect(neverUp.children).toHaveLength(1);
  expect(neverUp.output().err).toContain(
    "The Convex backend could not start (spawn ENOENT)",
  );
});

test("another deployment on the port, a backend that never answers, a bad config.json and a failed keygen are each refused with their own code and nothing left running", async () => {
  const taken = await harness({ recommended: NEW, answer: () => "other" });
  await expect(taken.start()).rejects.toMatchObject({
    code: "CONVEX_PORT_TAKEN",
  });
  expect(taken.children[0]!.stopped).toBe(true);

  const silent = await harness({ recommended: NEW, answer: () => undefined });
  await expect(silent.start()).rejects.toMatchObject({
    code: "CONVEX_BACKEND_START",
  });
  expect(silent.children.map((child) => child.stopped)).toEqual([true]);

  const broken = await harness({ recommended: NEW });
  await mkdir(broken.stateDir, { recursive: true });
  await writeFile(
    join(broken.stateDir, "config.json"),
    '{"deploymentName":"x"}',
  );
  await expect(broken.start()).rejects.toMatchObject({
    code: "CONVEX_STATE_INVALID",
    message: expect.stringContaining(join(broken.stateDir, "config.json")),
  });

  const keygen = await harness({
    recommended: NEW,
    keygen: { exitCode: 1, stdout: "", stderr: "bad secret\n" },
  });
  await expect(keygen.start()).rejects.toMatchObject({
    code: "CONVEX_KEYGEN",
    details: expect.objectContaining({ evidence: "bad secret" }),
  });
  await expect(
    readFile(join(keygen.stateDir, "config.json")),
  ).rejects.toThrow();
  expect(keygen.children).toEqual([]);
});

test("a stop ends the helper cleanly wherever it arrives: before anything starts, during keygen, or just after the group's SIGTERM ended a child", async () => {
  const early = await harness({ recommended: NEW });
  early.stop.abort();
  expect(await early.start()).toBe(0);
  expect(early.children).toEqual([]);

  const keygen = await harness({ recommended: NEW, stopDuringKeygen: true });
  expect(await keygen.start()).toBe(0);
  expect(keygen.children).toEqual([]);
  expect(keygen.output().err).toBe("");

  // The supervisor signals the whole group: convex dev may be seen ending before this process's own SIGTERM.
  const group = await harness({ recommended: NEW });
  expect(
    await group.start({}, ({ dev }) => {
      dev.end({ signal: "SIGTERM" });
      setTimeout(() => group.stop.abort(), 0);
    }),
  ).toBe(0);
  expect(group.children[0]!.stopped).toBe(true);
  expect(group.output().err).toBe("");
});

test("release choice follows convex dev: newer or same-day recommended releases are taken, older ones are not, and offline the newest cached one starts a deployment", () => {
  expect(nextRelease(OLD, { recommended: NEW })).toEqual({
    release: NEW,
    fallback: OLD,
  });
  expect(nextRelease(NEW, { recommended: OLD })).toEqual({ release: NEW });
  expect(nextRelease(NEW, { recommended: NEW })).toEqual({ release: NEW });
  expect(nextRelease(NEW, {})).toEqual({ release: NEW });
  expect(nextRelease(NEW, { pinned: OLD, recommended: NEW })).toEqual({
    release: OLD,
  });
  expect(newDeploymentRelease({ cached: [] })).toBeUndefined();
  expect(newDeploymentRelease({ cached: [NEW, OLD] })).toBe(NEW);
  expect(newDeploymentRelease({ recommended: OLD, cached: [NEW] })).toBe(OLD);
  expect(
    newDeploymentRelease({ pinned: "p", recommended: OLD, cached: [NEW] }),
  ).toBe("p");
});

test("the backend is only ever bound to loopback, and .env.local keeps every line it does not manage", () => {
  const args = backendArguments({
    deployment: {
      deploymentName: "n",
      backendVersion: NEW,
      adminKey: "k",
      instanceSecret: "s",
    },
    stateDir: "/data/backend",
    cloudPort: 1,
    sitePort: 2,
  });
  expect(args.slice(0, 2)).toEqual(["--interface", "127.0.0.1"]);
  expect(args.join(" ")).not.toContain("0.0.0.0");

  const pair = { url: "http://127.0.0.1:9", adminKey: "key" };
  const managed =
    "# Convex backend run by scripts/rig-convex.ts\nCONVEX_SELF_HOSTED_URL=http://127.0.0.1:9\nCONVEX_SELF_HOSTED_ADMIN_KEY=key\n";
  expect(selfHostedEnvFile(undefined, pair)).toBe(managed);
  expect(selfHostedEnvFile("", pair)).toBe(managed);
  // Written by design's hand-written script: its lines are replaced, not doubled.
  const fromScript =
    "A=1\n\n# Convex backend run by scripts/convex-backend.ts\nCONVEX_SELF_HOSTED_URL=http://127.0.0.1:5\nCONVEX_SELF_HOSTED_ADMIN_KEY=old\n";
  expect(selfHostedEnvFile(fromScript, pair)).toBe(`A=1\n\n${managed}`);
  expect(selfHostedEnvFile(selfHostedEnvFile(fromScript, pair), pair)).toBe(
    `A=1\n\n${managed}`,
  );
});

test("the script reads its settings from the environment, checks them before running anything, and passes arguments to convex dev", () => {
  const valid = {
    CONVEX_CLOUD_PORT: "47001",
    CONVEX_SITE_PORT: "47002",
    CONVEX_STATE_DIR: "/data/backend",
  };
  expect(
    readSettings(valid, ["--", "--typecheck", "disable"], "/work"),
  ).toEqual({
    cloudPort: 47001,
    sitePort: 47002,
    stateDir: "/data/backend",
    workspace: "/work",
    instanceName: "convex-self-hosted",
    devArguments: ["--typecheck", "disable"],
    environment: valid,
  });
  expect(
    readSettings(
      { ...valid, CONVEX_BACKEND_VERSION: NEW, CONVEX_INSTANCE_NAME: "app" },
      [],
      "/work",
    ),
  ).toMatchObject({
    pinnedRelease: NEW,
    instanceName: "app",
    devArguments: [],
  });
  for (const [changes, message] of [
    [
      { CONVEX_CLOUD_PORT: undefined },
      "CONVEX_CLOUD_PORT must be a port number from 1 to 65535.",
    ],
    [
      { CONVEX_CLOUD_PORT: "x" },
      "CONVEX_CLOUD_PORT must be a port number from 1 to 65535.",
    ],
    [
      { CONVEX_SITE_PORT: "70000" },
      "CONVEX_SITE_PORT must be a port number from 1 to 65535.",
    ],
    [
      { CONVEX_SITE_PORT: "47001" },
      "CONVEX_SITE_PORT must differ from CONVEX_CLOUD_PORT.",
    ],
    [
      { CONVEX_STATE_DIR: "data" },
      "CONVEX_STATE_DIR must be an absolute directory",
    ],
    [
      { CONVEX_BACKEND_VERSION: "../../etc" },
      "CONVEX_BACKEND_VERSION must be a Convex backend release name",
    ],
    [
      { CONVEX_INSTANCE_NAME: "Bad Name" },
      "CONVEX_INSTANCE_NAME must be lowercase",
    ],
  ] as const)
    expect(() => readSettings({ ...valid, ...changes }, [], "/work")).toThrow(
      expect.objectContaining({
        code: "CONVEX_SETTINGS",
        message: expect.stringContaining(message),
        hint: expect.stringContaining("rig.yaml"),
      }),
    );
});

test("a deployment an older Convex CLI made without credentials of its own gets new ones before its backend runs", async () => {
  const h = await harness({ recommended: NEW });
  await mkdir(h.stateDir, { recursive: true });
  await writeFile(
    join(h.stateDir, "config.json"),
    JSON.stringify({ deploymentName: "anonymous-app", backendVersion: NEW }),
  );
  expect(await h.start()).toBe(0);
  const config = JSON.parse(
    await readFile(join(h.stateDir, "config.json"), "utf8"),
  );
  expect(config).toEqual({
    deploymentName: "anonymous-app",
    backendVersion: NEW,
    instanceSecret: "f".repeat(64),
    adminKey: "anonymous-app|admin-key",
  });
  expect(h.children[0]!.command).toContain("f".repeat(64));
  expect(h.children[1]!.env.CONVEX_SELF_HOSTED_ADMIN_KEY).toBe(
    "anonymous-app|admin-key",
  );
});

test("a state directory with files but no config.json is refused, an empty one is used, and an interrupted copy leaves nothing half-adopted", async () => {
  const cluttered = await harness({ recommended: NEW });
  await mkdir(cluttered.stateDir, { recursive: true });
  await writeFile(
    join(cluttered.stateDir, "convex_local_backend.sqlite3"),
    "rows",
  );
  await expect(cluttered.start()).rejects.toMatchObject({
    code: "CONVEX_STATE_INCOMPLETE",
    hint: expect.stringContaining("move the directory aside"),
  });
  expect(cluttered.children).toEqual([]);

  // An empty state directory (as Rig or an earlier failed start leaves it) takes a copied deployment; a sibling the
  // copy does not own is left alone, and nothing of the copy is left beside it.
  const empty = await harness({ recommended: NEW });
  await mkdir(empty.stateDir, { recursive: true });
  await mkdir(`${empty.stateDir}.partial`, { recursive: true });
  await writeFile(join(`${empty.stateDir}.partial`, "keep"), "mine");
  const local = join(empty.workspace, ".convex", "local", "default");
  await mkdir(local, { recursive: true });
  await writeFile(
    join(local, "config.json"),
    JSON.stringify({
      deploymentName: "anonymous-app",
      backendVersion: NEW,
      adminKey: "k",
      instanceSecret: "s",
    }),
  );
  expect(await empty.start()).toBe(0);
  expect(
    JSON.parse(await readFile(join(empty.stateDir, "config.json"), "utf8"))
      .deploymentName,
  ).toBe("anonymous-app");
  expect(
    await readFile(join(`${empty.stateDir}.partial`, "keep"), "utf8"),
  ).toBe("mine");
  expect((await readdir(join(empty.stateDir, ".."))).sort()).toEqual([
    "backend",
    "backend.partial",
  ]);
});

test("a child that ignores SIGTERM after the other ended by itself is killed, so the failed Service ends", async () => {
  const h = await harness({ recommended: NEW, backendIgnoresStop: true });
  expect(await h.start({}, ({ dev }) => dev.end({ code: 3 }))).toBe(3);
  expect(h.children[0]!.killed).toBe(true);
  expect(h.output().err).toContain(
    "did not stop within 10 s of SIGTERM; killing it.",
  );
});

test("a backend that ends right after its deployment's name answered (another one owns the port) is not taken as up, and its release is not recorded", async () => {
  const h = await harness({ recommended: NEW, backendEnds: { code: 1 } });
  await mkdir(h.stateDir, { recursive: true });
  const config = JSON.stringify({
    deploymentName: "convex-self-hosted",
    backendVersion: OLD,
    adminKey: "k",
    instanceSecret: "s",
  });
  await writeFile(join(h.stateDir, "config.json"), config);
  expect(await h.start()).toBe(1);
  expect(h.children).toHaveLength(1);
  expect(await readFile(join(h.stateDir, "config.json"), "utf8")).toBe(config);
  expect(h.output().err).toContain("The Convex backend exited with code 1");
});

test("a new deployment whose recommended release cannot be downloaded starts on the newest cached one, unless a release was pinned", async () => {
  const h = await harness({
    recommended: NEW,
    cached: [OLD],
    unavailable: [NEW],
  });
  expect(await h.start()).toBe(0);
  expect(
    JSON.parse(await readFile(join(h.stateDir, "config.json"), "utf8"))
      .backendVersion,
  ).toBe(OLD);
  expect(h.output().err).toContain(
    `Starting on the cached Convex backend ${OLD}: Convex backend ${NEW} could not be downloaded (offline).`,
  );

  const pinned = await harness({ cached: [OLD], unavailable: [NEW] });
  await expect(pinned.start({ pinnedRelease: NEW })).rejects.toMatchObject({
    code: "CONVEX_BACKEND_DOWNLOAD",
  });
});

test("a backend already answering on the port before this one starts is refused, even one of the same deployment", async () => {
  const h = await harness({ recommended: NEW, occupied: "convex-self-hosted" });
  await writeFile(
    join(h.workspace, ".env.local"),
    "CONVEX_DEPLOYMENT=dev:app\n",
  );
  await expect(h.start()).rejects.toMatchObject({
    code: "CONVEX_PORT_TAKEN",
    hint: expect.stringContaining("an earlier one of this deployment"),
  });
  expect(h.children).toEqual([]);
  // .env.local is only pointed at a backend this Service is about to start.
  expect(await readFile(join(h.workspace, ".env.local"), "utf8")).toBe(
    "CONVEX_DEPLOYMENT=dev:app\n",
  );
});

test("under a pin, new credentials are made with a newer cached binary, as convex dev makes them with the latest", async () => {
  const h = await harness({ cached: [OLD, NEW] });
  await mkdir(h.stateDir, { recursive: true });
  await writeFile(
    join(h.stateDir, "config.json"),
    JSON.stringify({ deploymentName: "anonymous-app", backendVersion: OLD }),
  );
  expect(await h.start({ pinnedRelease: OLD })).toBe(0);
  expect(h.events).toEqual([
    `binary ${OLD}`,
    `binary ${NEW}`,
    expect.stringMatching(
      /^run keygen admin-key --instance-name anonymous-app /,
    ),
  ]);
  expect(h.children[0]!.command[0]).toBe(`/cache/${OLD}/convex-local-backend`);
});
