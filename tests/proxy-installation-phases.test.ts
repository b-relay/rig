import { afterEach, expect, mock, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as binaries from "../src/providers/caddy-binary";
import * as jobs from "../src/providers/caddy-job";
import * as managed from "../src/providers/managed-caddy";
import { RigError } from "../src/domain/errors";

/** Every step an install took, in order: the binary, publication, the job and its rollback. A step taken again is
 * numbered, as `job restart 2`. */
const trace: string[] = [];
/** The steps that fail, by their name in the trace, each with the error it fails with. */
const failing = new Map<string, Error>();
/** The candidate binary installCaddyBinary reports while faking, or undefined to use the real modules. */
let candidate: binaries.BinaryInstallation | undefined;
/** The fake job: whether it ran before the install, whether its install changes its definition, and what happens once its
 * state is read. */
const job: {
  running: boolean;
  definitionChanges: boolean;
  afterState?: () => Promise<void>;
} = { running: true, definitionChanges: false };
/** How many publishers from this process an install built. */
let publishers = 0;
function step(name: string): void {
  const taken = trace.filter(
    (each) => each === name || each.startsWith(`${name} `),
  ).length;
  const entry = taken ? `${name} ${taken + 1}` : name;
  trace.push(entry);
  const error = failing.get(entry);
  if (error) throw error;
}
// Each fake stands in only while a test sets `candidate`; otherwise the real module runs, for the other test files.
const real = {
  binary: { ...binaries },
  job: { ...jobs },
  managed: { ...managed },
};
mock.module("../src/providers/caddy-binary", () => ({
  ...real.binary,
  async installCaddyBinary(
    options: Parameters<typeof binaries.installCaddyBinary>[0],
  ) {
    if (!candidate) return real.binary.installCaddyBinary(options);
    step("binary");
    return candidate;
  },
  async revertBinary(paths: Parameters<typeof binaries.revertBinary>[0]) {
    if (!candidate) return real.binary.revertBinary(paths);
    step("revert");
    return true;
  },
  async confirmBinary(paths: Parameters<typeof binaries.confirmBinary>[0]) {
    if (!candidate) return real.binary.confirmBinary(paths);
    step("confirm");
  },
}));
mock.module("../src/providers/caddy-job", () => ({
  ...real.job,
  createCaddyJob(options: Parameters<typeof jobs.createCaddyJob>[0]) {
    if (!candidate) return real.job.createCaddyJob(options);
    return {
      description: "the fake job",
      state: async () => {
        const state = job.running ? "running" : "stopped";
        await job.afterState?.();
        return state;
      },
      matches: async () => true,
      install: async () => {
        step("job install");
        return { changed: job.definitionChanges };
      },
      restart: async () => step("job restart"),
      remove: async () => {},
    };
  },
}));
mock.module("../src/providers/managed-caddy", () => ({
  ...real.managed,
  createManagedCaddy(
    options: Parameters<typeof managed.createManagedCaddy>[0],
  ) {
    if (!candidate) return real.managed.createManagedCaddy(options);
    publishers++;
    return {
      republish: async () => step("publish here"),
      close: async () => step("close"),
    };
  },
}));
const { createProxyInstallation } =
  await import("../src/daemon/proxy-installation");
type ProxyInstallation = ReturnType<typeof createProxyInstallation>;

const roots: string[] = [];
afterEach(async () => {
  candidate = undefined;
  Object.assign(job, {
    running: true,
    definitionChanges: false,
    afterState: undefined,
  });
  trace.length = 0;
  failing.clear();
  publishers = 0;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const TOKEN = "T".repeat(40);
/** An installation under a temporary Rig root whose Caddy binary changes from a previous one that served, unless `binary`
 * says it is unchanged or has no previous copy. */
async function installation(
  binary: { changed: boolean; previous: boolean } = {
    changed: true,
    previous: true,
  },
) {
  const root = await mkdtemp(join(tmpdir(), "rig-phases-"));
  roots.push(root);
  await writeFile(
    join(root, "config.yaml"),
    "proxy:\n  caddy: /source/caddy\n  tls: { ca: internal }\n",
  );
  await mkdir(join(root, "auth"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, "auth", "acme-dns.token"), TOKEN, { mode: 0o600 });
  await mkdir(join(root, "caddy"), { recursive: true });
  await writeFile(
    join(root, "caddy", "launchd.log"),
    `listening\nusing ${TOKEN}\nthe new Caddy exited\n`,
  );
  candidate = {
    changed: binary.changed,
    file: join(root, "caddy", "bin", "caddy-new"),
    ...(binary.previous
      ? { previous: join(root, "caddy", "bin", "caddy-old") }
      : {}),
    version: "v2.10.9",
  };
  return createProxyInstallation({
    root,
    userHome: join(root, "home"),
    uid: process.getuid!(),
    userName: "test",
    mode: "process",
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  });
}
test("a complete install publishes before the job runs the new binary, restarts the job that kept running, then confirms it", async () => {
  const proxy = await installation();
  await proxy.install();
  expect(publishers).toBe(1);
  expect(trace).toEqual([
    "binary",
    "publish here",
    "close",
    "job install",
    "job restart",
    "confirm",
  ]);
});

test("a complete install restarts the job only when a changed binary would otherwise keep running the old one, and confirms only a changed binary", async () => {
  for (const changed of [false, true])
    for (const running of [false, true])
      for (const definitionChanges of [false, true]) {
        const restarts = changed && running && !definitionChanges;
        const activation = [
          "job install",
          ...(restarts ? ["job restart"] : []),
          ...(changed ? ["confirm"] : []),
        ];
        for (const publishedBy of ["here", "rigd"] as const) {
          const proxy = await installation({ changed, previous: true });
          Object.assign(job, { running, definitionChanges });
          trace.length = 0;
          if (publishedBy === "here") await proxy.install();
          else
            await proxy.installPublishedBy(async () => step("rigd publishes"));
          expect({
            changed,
            running,
            definitionChanges,
            publishedBy,
            trace,
          }).toEqual({
            changed,
            running,
            definitionChanges,
            publishedBy,
            trace: [
              "binary",
              ...(publishedBy === "here"
                ? ["publish here", "close"]
                : ["rigd publishes"]),
              ...activation,
            ],
          });
        }
      }
});

test("a new binary with no previous copy that does not start is reverted, and its start failure passes through with no restart", async () => {
  const proxy = await installation({ changed: true, previous: false });
  const failure = new RigError(
    "PROXY_START",
    "Caddy did not answer.",
    "Read its log.",
  );
  failing.set("job restart", failure);
  const error = await proxy.install().catch((caught: unknown) => caught);
  expect(error).toBe(failure);
  expect(trace).toEqual([
    "binary",
    "publish here",
    "close",
    "job install",
    "job restart",
    "revert",
  ]);
});

test("a revert that fails during either rollback ends the install with its own error, and nothing after it runs", async () => {
  const revertFailure = new Error("the link could not be switched back");
  const proxy = await installation();
  failing.set(
    "job restart",
    new RigError("PROXY_START", "Caddy did not answer.", "Read its log."),
  );
  failing.set("revert", revertFailure);
  expect(await proxy.install().catch((caught: unknown) => caught)).toBe(
    revertFailure,
  );
  expect(trace).toEqual([
    "binary",
    "publish here",
    "close",
    "job install",
    "job restart",
    "revert",
  ]);

  trace.length = 0;
  failing.clear();
  failing.set("rigd publishes", new Error("rigd refused"));
  failing.set("revert", revertFailure);
  expect(
    await proxy
      .installPublishedBy(async () => step("rigd publishes"))
      .catch((caught: unknown) => caught),
  ).toBe(revertFailure);
  expect(trace).toEqual(["binary", "rigd publishes", "revert"]);
});

test("every install refuses a config.yaml that can no longer be read once the job is known, before it stages anything", async () => {
  const installs = {
    complete: (proxy: ProxyInstallation) => proxy.install(),
    stage: (proxy: ProxyInstallation) => proxy.stage(),
    "published by rigd": (proxy: ProxyInstallation) =>
      proxy.installPublishedBy(async () => step("rigd publishes")),
  };
  for (const [name, install] of Object.entries(installs)) {
    const proxy = await installation();
    const config = join(roots.at(-1)!, "config.yaml");
    job.afterState = () => chmod(config, 0o000);
    trace.length = 0;
    const error = await install(proxy).catch((caught: unknown) => caught);
    expect({ name, error, trace }).toEqual({
      name,
      error: expect.objectContaining({
        code: "read_failed",
        message: "Unable to read config document.",
      }),
      trace: [],
    });
  }
});

test("staging stops once the routes are published: no job is defined and the new binary stays unconfirmed", async () => {
  const proxy = await installation();
  await proxy.stage();
  expect(trace).toEqual(["binary", "publish here", "close"]);
});

test("a staging whose publication fails puts the previous binary back and defines no job", async () => {
  const proxy = await installation();
  failing.set("publish here", new Error("Caddy refused the routes"));
  await expect(proxy.stage()).rejects.toThrow("Caddy refused the routes");
  expect(trace).toEqual(["binary", "publish here", "revert"]);
});

test("beside a running system rigd, that rigd publishes instead of this install, before the job runs the new binary", async () => {
  const proxy = await installation();
  const publish = async () => step("rigd publishes");
  await proxy.installPublishedBy(publish);
  // Nothing publishes from here, so no publisher is built here.
  expect(publishers).toBe(0);
  expect(trace).toEqual([
    "binary",
    "rigd publishes",
    "job install",
    "job restart",
    "confirm",
  ]);
});

test("a publication the running system rigd refuses puts the previous binary back and leaves the job alone", async () => {
  const proxy = await installation();
  const refusal = new RigError("PROXY_APPLY", "Refused.", "Retry.");
  const error = await proxy
    .installPublishedBy(async () => {
      step("rigd publishes");
      throw refusal;
    })
    .catch((caught: unknown) => caught);
  expect(error).toBe(refusal);
  expect(trace).toEqual(["binary", "rigd publishes", "revert"]);
});

test("a new binary that does not start is reverted and the previous one started again, with the job log's last lines redacted as evidence", async () => {
  const proxy = await installation();
  failing.set(
    "job restart",
    new RigError("PROXY_START", "Caddy did not answer.", "Read its log."),
  );
  // The restart that brings the previous binary back fails too, so the job is installed again instead.
  failing.set("job restart 2", new Error("restart refused"));
  const error = await proxy.install().catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    code: "PROXY_BINARY_START",
    message:
      "The new Caddy (v2.10.9) did not start, so the previous one runs again.",
  });
  const evidence = String((error as RigError).details?.evidence);
  expect(evidence).toContain("the new Caddy exited");
  expect(evidence).not.toContain(TOKEN);
  expect(trace).toEqual([
    "binary",
    "publish here",
    "close",
    "job install",
    "job restart",
    "revert",
    "job restart 2",
    "job install 2",
  ]);
});

test("a job launchd refuses is not blamed on the new binary: it is reverted and the refusal passes through", async () => {
  const proxy = await installation();
  const refusal = new RigError("LAUNCHD", "launchctl refused.", "Retry.");
  failing.set("job install", refusal);
  const error = await proxy.install().catch((caught: unknown) => caught);
  expect(error).toBe(refusal);
  expect(trace).toEqual([
    "binary",
    "publish here",
    "close",
    "job install",
    "revert",
  ]);
});
