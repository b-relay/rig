import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectHostProxy } from "../src/adapters/proxy-publication";
import { parseHostConfig, parseProjectConfig } from "../src/config";
import type { DoctorCheck } from "../src/daemon/offline-doctor";
import { runCommand } from "../src/providers/command-runner";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import type { Router } from "../src/providers/caddy-router";
import { proxyPaths } from "../src/domain/managed-proxy";
import { managedCaddyWorld } from "./support/managed-caddy-double";
import {
  runtimeWorld,
  type RuntimeWorldOptions,
} from "./support/runtime-world";

/** What doctor says of a recorded Target's own prerequisites, through the real runtime, Target effects and route files over a
 * scripted supervisor: the env files a start reads (#422) and the route block its hostnames are served from (#572). */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const WEB = 47411;

/** One Project `demo` of `project`, its rig.yaml read live from `config`, so a test may edit it. `proxy` replaces the route
 * file under the root with another router's; `wrapEffects` lets a test act between two steps of the Target effects. */
async function world(
  project: Record<string, unknown>,
  options: {
    proxy?: {
      router: Router;
      inspect: () => ReturnType<typeof inspectHostProxy>;
    };
    wrapEffects?: RuntimeWorldOptions["wrapEffects"];
  } = {},
) {
  const { proxy } = options;
  const config = parseProjectConfig({ name: "demo", ...project });
  const processes = new Map<string, ProcessObservation>();
  /** Every Service start, in order. */
  const starts: string[] = [];
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      starts.push(request.componentName);
      processes.set(request.key, {
        state: "running",
        pid: 6000 + starts.length,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      processes.delete(key);
      return { outcome: "stopped" };
    },
    async shutdown() {},
    async detach() {},
  };
  const w = await runtimeWorld({
    name: "doctor-evidence",
    config,
    supervisor: () => supervisor,
    ...(options.wrapEffects ? { wrapEffects: options.wrapEffects } : {}),
    startsAt: "2026-11-08T08:00:00.000Z",
    readinessDeadlineMs: 300,
    activation: {
      connect: async () => ({ ready: true }),
      listeners: {
        inspect: async (pid) => ({
          state: "observed",
          listeners: [{ pid, address: "127.0.0.1", port: WEB }],
        }),
      },
    },
    ...(proxy ? { router: proxy.router } : {}),
    // The route file as rigd reads it, through Host config's providers.caddy.
    dependencies: ({ root }) => ({
      inspectProxy:
        proxy?.inspect ??
        (() =>
          inspectHostProxy(
            root,
            parseHostConfig({
              providers: { caddy: { caddyfile: join(root, "Caddyfile") } },
            }),
            {},
          )),
    }),
  });
  roots.push(w.root);
  const runtime = w.open();
  await runtime.command({ action: "init", repoPath: w.repo });
  const doctor = async () =>
    (await runtime.command({ action: "doctor", project: "demo" })) as {
      ok: boolean;
      checks: DoctorCheck[];
    };
  return {
    ...w,
    config,
    starts,
    command: runtime.command.bind(runtime),
    doctor,
    check: async (name: string) =>
      (await doctor()).checks.find((check) => check.name === name),
  };
}
const routed = (domain = "dev.probe.test") => ({
  services: { web: { command: "serve", ports: { http: WEB } } },
  targets: { working: { domain } },
});

test("doctor fails a Target whose required env_file is missing, names the file, who reads it and the hint, and inspects the rest", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "rig-doctor-env-"));
  roots.push(scratch);
  const absent = join(scratch, "absent.env");
  const w = await world({
    services: {
      web: { command: "serve", ports: { http: WEB }, env_file: absent },
    },
    targets: { working: true },
  });
  await expect(
    w.command({ action: "up", project: "demo", target: "working" }),
  ).rejects.toMatchObject({ code: "ENV_FILE_MISSING" });
  const report = await w.doctor();
  expect(report.ok).toBe(false);
  expect(
    report.checks.find((check) => check.name === "working/env-files"),
  ).toEqual({
    name: "working/env-files",
    ok: false,
    message: `The environment file ${absent} does not exist. Read by Service web. Rig cannot use it as it is now; what already runs keeps running.`,
    reason: "env-file-unusable",
    hint: "A listed env_file is required. A deployed Target resolves a relative path inside its checked-out Commit, where an ignored file is absent: provide the values under ~/.rig/env/<project>/, or list an absolute or ~/ path outside the repository. Never commit a file that holds secrets.",
  });
  // The other checks still run: the recorded plan still matches rig.yaml, and its optional convention files, absent, are fine.
  expect(
    report.checks.find((check) => check.name === "working/config"),
  ).toMatchObject({ ok: true });
  // Provided, it passes and the Target starts.
  await writeFile(absent, "TOKEN=secret-value\n", { mode: 0o600 });
  expect(await w.check("working/env-files")).toBeUndefined();
  await w.command({ action: "up", project: "demo", target: "working" });
  expect(w.starts).toEqual(["web"]);
  expect((await w.doctor()).ok).toBe(true);
});

test("doctor fails a Target whose env file lies in the repository without Git ignoring it, never showing a value, until Git ignores it", async () => {
  const w = await world({
    env_file: ".env",
    services: { web: { command: "serve", ports: { http: WEB } } },
    targets: { working: true },
  });
  const git = (...args: string[]) =>
    runCommand({ command: ["git", ...args], cwd: w.repo, env: {} });
  expect((await git("init", "-q")).exitCode).toBe(0);
  await writeFile(join(w.repo, ".env"), "TOKEN=hunter2-secret\n", {
    mode: 0o600,
  });
  await expect(
    w.command({ action: "up", project: "demo", target: "working" }),
  ).rejects.toMatchObject({ code: "ENV_FILE_TRACKED" });
  const check = await w.check("working/env-files");
  expect(check).toMatchObject({
    ok: false,
    reason: "env-file-unusable",
    message: `The environment file ${join(w.repo, ".env")} is inside the repository and Git does not ignore it. Read by the whole Project. Rig cannot use it as it is now; what already runs keeps running.`,
    hint: expect.stringContaining("add the path to .gitignore"),
  });
  expect(JSON.stringify(await w.doctor())).not.toContain("hunter2-secret");
  await writeFile(join(w.repo, ".gitignore"), ".env\n");
  expect(await w.check("working/env-files")).toBeUndefined();
});

test.each([
  ["a NUL in a value", "TOKEN=synthetic-secret\0bad\n", "line 1"],
  ["bytes that are not UTF-8", Buffer.from([84, 61, 255, 10]), "line 1"],
])(
  "doctor fails a Target whose env file holds %s, a value Rig refuses, stopped or running, never showing the value",
  async (_, content, line) => {
    const scratch = await mkdtemp(join(tmpdir(), "rig-doctor-value-"));
    roots.push(scratch);
    const file = join(scratch, "values.env");
    const w = await world({
      env_file: file,
      services: { web: { command: "serve", ports: { http: WEB } } },
      targets: { working: true },
    });
    const finding = {
      name: "working/env-files",
      ok: false,
      message: expect.stringMatching(
        new RegExp(
          `^The environment file ${file} has .* on ${line}.* Read by the whole Project\\. Rig cannot use it as it is now; what already runs keeps running\\.$`,
        ),
      ),
      reason: "env-file-unusable",
      hint: expect.any(String),
    };
    const unshown = async () =>
      expect(JSON.stringify(await w.doctor())).not.toContain(
        "synthetic-secret",
      );
    // Stopped: the start is refused, and doctor says why.
    await writeFile(file, content, { mode: 0o600 });
    await expect(
      w.command({ action: "up", project: "demo", target: "working" }),
    ).rejects.toMatchObject({ code: "ENV_VALUE" });
    expect(await w.check("working/env-files")).toEqual(finding);
    await unshown();
    // Running from a good file, the same edit leaves it running, and doctor still names the file Rig cannot use.
    await writeFile(file, "TOKEN=synthetic-secret\n");
    await w.command({ action: "up", project: "demo", target: "working" });
    expect(await w.check("working/env-files")).toBeUndefined();
    await writeFile(file, content);
    expect(await w.check("working/env-files")).toEqual(finding);
    await unshown();
  },
);

test("doctor fails a Target whose optional operator env file is present but refused, naming who reads it, never a value", async () => {
  const w = await world({
    services: { web: { command: "serve", ports: { http: WEB } } },
    targets: { working: true },
  });
  const project = join(w.root, "env", "demo", "all.env");
  const service = join(w.root, "env", "demo", "web", "working.env");
  await mkdir(dirname(service), { recursive: true });
  await writeFile(project, "TOKEN=hunter3-value\nnot an assignment\n");
  await writeFile(service, 'OTHER="hunter3-value\n');
  await expect(
    w.command({ action: "up", project: "demo", target: "working" }),
  ).rejects.toMatchObject({ code: "ENV_FILE" });
  const report = await w.doctor();
  expect(
    report.checks.find((check) => check.name === "working/env-files"),
  ).toEqual({
    name: "working/env-files",
    ok: false,
    message: `The environment file ${project} has an unsupported assignment on line 2. Read by the whole Project. The environment file ${service} has an unmatched quote on line 1. Read by Service web. Rig cannot use them as they are now; what already runs keeps running.`,
    reason: "env-file-unusable",
    hint: "Use one KEY=value assignment per line; a bare KEY without = is not an assignment. Close the quote on the same line; a value cannot span lines.",
  });
  expect(JSON.stringify(report)).not.toContain("hunter3-value");
  // Fixed, the optional files load and the Target starts.
  await writeFile(project, "TOKEN=hunter3-value\n");
  await writeFile(service, 'OTHER="hunter3-value"\n');
  expect(await w.check("working/env-files")).toBeUndefined();
  await w.command({ action: "up", project: "demo", target: "working" });
});

test("doctor does not take a route a restart is replacing for a missing one: the Target it compared is no longer what state records", async () => {
  let holdRoute = false;
  let routeEntered!: () => void, resumeRoute!: () => void;
  const routeSeen = new Promise<void>((resolve) => (routeEntered = resolve));
  const routeGate = new Promise<void>((resolve) => (resumeRoute = resolve));
  const w = await world(routed("old.probe.test"), {
    // The restart pauses once its new hostname is published, before it records the Target running again.
    wrapEffects: (effects) => ({
      ...effects,
      async route(target, change) {
        await effects.route(target, change);
        if (holdRoute && target.plan.domain === "new.probe.test") {
          holdRoute = false;
          routeEntered();
          await routeGate;
        }
      },
    }),
  });
  await w.command({ action: "up", project: "demo", target: "working" });
  // Doctor pauses in its Host checks, after it read the Target and before it reads the route file.
  let hostEntered!: () => void, releaseHost!: () => void;
  const inHost = new Promise<void>((resolve) => (hostEntered = resolve));
  const hostGate = new Promise<void>((resolve) => (releaseHost = resolve));
  w.deps.inspectHost = async () => {
    hostEntered();
    await hostGate;
    return [];
  };
  const pending = w.doctor();
  await inHost;
  w.config.targets!.working = { domain: "new.probe.test" };
  holdRoute = true;
  const restart = w.command({
    action: "restart",
    project: "demo",
    target: "working",
  });
  await routeSeen;
  releaseHost();
  const report = await pending;
  expect(
    report.checks.filter((check) => check.reason === "route-missing"),
  ).toEqual([]);
  expect(
    report.checks.find((check) => check.name === "working/hostnames"),
  ).toEqual({
    name: "working/hostnames",
    ok: true,
    message: "Recorded hostnames: old.probe.test (web).",
  });
  resumeRoute();
  await restart;
  w.deps.inspectHost = async () => [];
  expect(await w.check("working/hostnames")).toEqual({
    name: "working/hostnames",
    ok: true,
    message: "Recorded hostnames: new.probe.test (web).",
  });
});

test("a write that leaves a Target's route as it was, such as a new updatedAt, does not hide its missing route", async () => {
  const w = await world(routed());
  await w.command({ action: "up", project: "demo", target: "working" });
  await writeFile(join(w.root, "Caddyfile"), "");
  // Every read of the route file is followed by a write of the Target that changes only when it was updated.
  const inspect = w.deps.inspectProxy;
  let writes = 0;
  w.deps.inspectProxy = async () => {
    const publication = await inspect();
    await w.store.update((state) => {
      state.targets[0]!.updatedAt = new Date(
        Date.UTC(2027, 0, ++writes),
      ).toISOString();
    });
    return publication;
  };
  for (let run = 1; run <= 3; run++) {
    expect(await w.check("working/hostnames")).toMatchObject({
      ok: false,
      reason: "route-missing",
    });
    // Doctor read the route file this run (the Host's route-owners check reads it too), and the record changed after.
    expect(writes).toBeGreaterThanOrEqual(run);
  }
});

test("doctor fails a running Target whose route block is gone from the route file, until rig up publishes it again without a restart", async () => {
  const w = await world(routed());
  await w.command({ action: "up", project: "demo", target: "working" });
  const proxyFile = join(w.root, "Caddyfile");
  const hostnames = {
    name: "working/hostnames",
    ok: true,
    message: "Recorded hostnames: dev.probe.test (web).",
  };
  expect(await w.check("working/hostnames")).toEqual(hostnames);
  expect((await w.doctor()).ok).toBe(true);
  const published = await readFile(proxyFile, "utf8");
  await writeFile(proxyFile, "");
  const report = await w.doctor();
  expect(report.ok).toBe(false);
  expect(
    report.checks.find((check) => check.name === "working/hostnames"),
  ).toEqual({
    name: "working/hostnames",
    ok: false,
    message: `Recorded hostnames: dev.probe.test (web). ${proxyFile} holds no route for working, though it is recorded running: Caddy serves its hostnames from that file, so that one is not served, or not after Caddy's next reload.`,
    reason: "route-missing",
    hint: "Run rig up working --project demo to publish its route again; its running Services keep running.",
  });
  // The hint's command publishes it again, and starts nothing.
  await w.command({ action: "up", project: "demo", target: "working" });
  expect(await readFile(proxyFile, "utf8")).toBe(published);
  expect(w.starts).toEqual(["web"]);
  expect(await w.check("working/hostnames")).toEqual(hostnames);
  // A stopped Target keeps its route withheld, and one whose block is gone is not judged: it serves nothing either way.
  await w.command({ action: "down", project: "demo", target: "working" });
  await writeFile(proxyFile, "");
  expect(await w.check("working/hostnames")).toEqual(hostnames);
});

test("doctor fails a running Target whose block in Rig's own Caddy's route file lacks one of its hostnames", async () => {
  const managed = await managedCaddyWorld();
  roots.push(managed.root);
  const host = parseHostConfig({ proxy: { caddy: "/usr/local/bin/caddy" } });
  const w = await world(routed(), {
    proxy: {
      router: managed.caddy.router,
      inspect: () => inspectHostProxy(managed.root, host, {}),
    },
  });
  await w.command({ action: "up", project: "demo", target: "working" });
  expect(await w.check("working/hostnames")).toMatchObject({ ok: true });
  // The block is still there, but serves another hostname than the one recorded.
  const routes = proxyPaths(managed.root).routes;
  await writeFile(
    routes,
    (await readFile(routes, "utf8")).replace(
      "dev.probe.test {",
      "old.probe.test {",
    ),
  );
  expect(await w.check("working/hostnames")).toMatchObject({
    ok: false,
    reason: "route-missing",
    message: expect.stringContaining(
      `The route of working in ${routes} does not serve dev.probe.test, though it is recorded running`,
    ),
  });
  await w.command({ action: "up", project: "demo", target: "working" });
  expect(await w.check("working/hostnames")).toMatchObject({ ok: true });
});

test("a Project with no hostname, and a fresh Host, get no route finding", async () => {
  const w = await world({
    services: { web: { command: "serve", ports: { http: WEB } } },
    targets: { working: true },
  });
  expect((await w.doctor()).ok).toBe(true);
  await w.command({ action: "up", project: "demo", target: "working" });
  const report = await w.doctor();
  expect(report.ok).toBe(true);
  expect(
    report.checks.find((check) => check.name === "working/hostnames"),
  ).toBeUndefined();
});
