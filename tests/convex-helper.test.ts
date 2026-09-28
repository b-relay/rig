import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runConvexCli,
  type ConvexCommandOptions,
} from "../src/cli/convex-command";
import { RigError } from "../src/domain/errors";
import type {
  ChildExit,
  ConvexHelperDependencies,
  RunningChild,
} from "../src/helpers/convex-contracts";
import {
  backendArguments,
  newDeploymentRelease,
  nextRelease,
  selfHostedEnvFile,
} from "../src/helpers/convex-deployment";
import {
  runConvexDeployment,
  type ConvexRunRequest,
} from "../src/helpers/convex-local";
import { createDeploymentFiles } from "../src/providers/deployment-files";

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
  const deps: ConvexHelperDependencies = {
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
        if (options.unavailable?.includes(release))
          throw new RigError(
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
            child.end({ signal: "SIGTERM" });
          },
        };
        children.push(child);
        if (children.length === 1 && options.backendEnds)
          child.end(options.backendEnds);
        return child;
      },
    },
    files: createDeploymentFiles(),
    async run(request) {
      events.push(`run ${request.command.slice(1).join(" ")}`);
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
      if (!backend || url !== `http://127.0.0.1:47001/instance_name`)
        return undefined;
      const name =
        backend.command[backend.command.indexOf("--instance-name") + 1]!;
      return (options.answer ?? ((own) => own))(name);
    },
    async wait() {
      clock += 250;
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
    const result = runConvexDeployment(
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
    "# Deployment used by `npx convex dev`\nCONVEX_DEPLOYMENT=anonymous:anonymous-app # team: x\n\nVITE_CONVEX_URL=http://127.0.0.1:3210\nAPP_KEY=keep\n",
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
  expect(dev!.env.CONVEX_DEPLOYMENT).toBeUndefined();
  expect(backend!.stopped && dev!.stopped).toBe(true);
  expect(await readFile(join(h.workspace, ".env.local"), "utf8")).toBe(
    "VITE_CONVEX_URL=http://127.0.0.1:3210\nAPP_KEY=keep\n\n# Convex backend run by rigd convex (the convex recipe)\nCONVEX_SELF_HOSTED_URL=http://127.0.0.1:47001\nCONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|admin-key\n",
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

  const offline = await harness({ recommended: NEW, unavailable: [NEW] });
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
    `Staying on Convex backend ${OLD}: Convex backend ${NEW} could not be downloaded (offline).`,
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
  await writeFile(join(local, "config.json"), config);
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
    hint: expect.stringContaining("--backend-version"),
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

test("a stop before the backend is chosen starts nothing and ends cleanly", async () => {
  const h = await harness({ recommended: NEW });
  h.stop.abort();
  expect(await h.start()).toBe(0);
  expect(h.children).toEqual([]);
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
    "# Convex backend run by rigd convex (the convex recipe)\nCONVEX_SELF_HOSTED_URL=http://127.0.0.1:9\nCONVEX_SELF_HOSTED_ADMIN_KEY=key\n";
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

test("rigd convex checks its options before running anything, passes operands to convex dev, and answers --help and -h", async () => {
  const runs: ConvexCommandOptions[] = [];
  let out = "";
  let err = "";
  const cli = (...args: string[]) => {
    out = "";
    err = "";
    return runConvexCli(["convex", ...args], {
      output: {
        write: (text) => void (out += text),
        error: (text) => void (err += text),
      },
      run: async (options) => {
        runs.push(options);
        return 7;
      },
    });
  };
  for (const flag of ["--help", "-h"]) {
    expect(await cli(flag)).toBe(0);
    expect(out).toContain("Usage: rigd convex [options] [convex-dev-args...]");
    expect(out).toContain("--state-dir <dir>");
  }
  const valid = [
    "--cloud-port",
    "47001",
    "--site-port",
    "47002",
    "--state-dir",
    "/data/backend",
  ];
  expect(await cli(...valid, "--", "--typecheck", "disable")).toBe(7);
  expect(runs).toEqual([
    {
      cloudPort: 47001,
      sitePort: 47002,
      stateDir: "/data/backend",
      instanceName: "convex-self-hosted",
      devArguments: ["--typecheck", "disable"],
    },
  ]);
  expect(
    await cli(...valid, "--backend-version", NEW, "--instance-name", "app"),
  ).toBe(7);
  expect(runs.at(-1)).toMatchObject({
    backendVersion: NEW,
    instanceName: "app",
  });
  for (const [args, message] of [
    [
      ["--site-port", "2", "--state-dir", "/d"],
      "required option '--cloud-port <port>' not specified",
    ],
    [
      ["--cloud-port", "x", "--site-port", "2", "--state-dir", "/d"],
      "--cloud-port must be a port number from 1 to 65535.",
    ],
    [
      ["--cloud-port", "70000", "--site-port", "2", "--state-dir", "/d"],
      "--cloud-port must be a port number from 1 to 65535.",
    ],
    [
      ["--cloud-port", "2", "--site-port", "2", "--state-dir", "/d"],
      "--site-port must differ from --cloud-port.",
    ],
    [
      ["--cloud-port", "1", "--site-port", "2", "--state-dir", "data"],
      "--state-dir must be an absolute path",
    ],
    [
      [...valid, "--backend-version", "../../etc"],
      "--backend-version must be a Convex backend release name",
    ],
    [
      [...valid, "--instance-name", "Bad Name"],
      "--instance-name must be lowercase",
    ],
  ] as const) {
    const before = runs.length;
    expect(await cli(...args)).toBe(1);
    expect(err).toContain(message);
    expect(err).toContain("Run rigd convex --help.");
    expect(runs).toHaveLength(before);
  }
  const failing = await runConvexCli(["convex", ...valid], {
    output: { write: () => {}, error: (text) => void (err = text) },
    run: async () => {
      throw new RigError("CONVEX_KEYGEN", "No key.", "Check the binary.");
    },
  });
  expect(failing).toBe(1);
  expect(err).toBe("rigd convex: No key. (CONVEX_KEYGEN)\nCheck the binary.\n");
});
