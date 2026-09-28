import { expect, test } from "bun:test";
import { loopbackListeners } from "./support/activation-doubles";
import { controlledDeadline } from "./controlled-observation-deadline";
import { createRuntime } from "../src/runtime/application";
import { createTargetLifecycle } from "../src/runtime/lifecycle";
import type { TargetEffects } from "../src/runtime/lifecycle";
import type { RuntimeState } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type {
  StopKill,
  StopRequest,
  StopResult,
} from "../src/providers/contracts";
import { stopDetached } from "../src/domain/stop-budget";
import {
  parseHostConfig,
  parseProjectConfig,
  resolveTargetPlan,
} from "../src/config";

/** One stop the supervisor was asked for, held until the test lets the Service exit (or kill it). */
interface HeldStop {
  key: string;
  request: StopRequest;
  exit(killed?: StopKill): void;
  /** The stop fails, as a supervisor that cannot reach the process does. */
  fail(error: Error): void;
}

/** rigd's runtime over the real lifecycle, with a scripted supervisor: a stop waits until the test ends it, so each path is
 * seen waiting on the Service's stop_timeout without any real time passing. web has stop_timeout 2m, worker 25m. */
function world() {
  let clock = Date.parse("2026-09-27T04:00:00.000Z");
  const state: RuntimeState = {
    version: 4,
    projects: [],
    targets: [],
    activity: [],
  };
  const config = parseProjectConfig({
    name: "fletcher",
    services: {
      web: { run: "serve", ports: { http: 4567 }, stop_timeout: "2m" },
      worker: { run: "work", depends_on: ["web"], stop_timeout: "25m" },
    },
  });
  const running = new Set<string>();
  const held: HeldStop[] = [];
  const stops: { key: string; graceMs: number; kill: boolean }[] = [];
  let holding = false;
  /** Preparation waits on this, as a long build does. */
  let preparing: Promise<void> | undefined;
  /** The next start of this Service fails, as a broken release does. */
  const failing = new Set<string>();
  const effects: TargetEffects = {
    async checkpoint(target) {
      return { targetId: target.id, async commit() {}, async rollback() {} };
    },
    async restoreEffects() {},
    async commitEffects() {},
    async retireSuperseded() {},
    async pruneCheckpoints() {
      return [];
    },
    async retireArtifacts() {},
    supervisor: () => ({
      async observe(key) {
        return running.has(key)
          ? { state: "running", pid: 42 }
          : { state: "stopped" };
      },
      async stop(key, request): Promise<StopResult> {
        if (!running.has(key)) return { outcome: "unchanged" };
        stops.push({
          key,
          graceMs: request.graceMs,
          kill: request.kill?.aborted ?? false,
        });
        if (!holding) {
          running.delete(key);
          return { outcome: "stopped" };
        }
        return await new Promise((resolve, reject) => {
          request.detach?.addEventListener("abort", () =>
            reject(stopDetached({ key })),
          );
          held.push({
            key,
            request,
            exit(killed) {
              running.delete(key);
              resolve({ outcome: "stopped", ...(killed ? { killed } : {}) });
            },
            fail: reject,
          });
        });
      },
      async ensureRunning(request) {
        const broken = [...failing].find((name) =>
          request.key.endsWith(`:${name}`),
        );
        if (broken) {
          // Only the next start fails: the release being rolled back to starts again.
          failing.delete(broken);
          throw new Error("the release does not start");
        }
        running.add(request.key);
        return { outcome: "started", pid: 42 };
      },
      async shutdown() {},
      async detach() {},
    }),
    async prepare() {
      await preparing;
    },
    async environment() {
      return {};
    },
    async health() {
      return { ready: true };
    },
    async build() {},
    async install() {
      return { outcome: "unchanged" };
    },
    async route() {},
    async removeRoute() {},
    listeners: async (pid: number) =>
      loopbackListeners(pid, [4567, 5000, 5001, 5002]),
  };
  let id = 0;
  const deps: RuntimeDependencies = {
    root: "/tmp/isolated-rig-278",
    async readAdminActivity() {
      return [];
    },
    async inspectHost() {
      return [];
    },
    async inspectProxy() {
      return {
        proxyFile: "/tmp/isolated-rig-278/proxy/Caddyfile",
        routes: 0,
        state: "imported" as const,
        hostCaddyfile: "/tmp/isolated-rig-278/Caddyfile",
      };
    },
    store: {
      async read() {
        return structuredClone(state);
      },
      // As the file store does: a change works on a copy and what it saved keeps no reference to the caller's objects.
      async update(change) {
        const next = structuredClone(state);
        await change(next);
        Object.assign(state, structuredClone(next));
      },
    },
    documents: {
      async initializationInfo() {
        return {
          name: "fletcher",
          productionBranch: "main",
          gitRequired: false,
          existing: true,
        };
      },
      async identifyInitialization(path) {
        return { repoPath: path, name: "fletcher" };
      },
      async discover(path) {
        return {
          repoPath: path,
          document: await this.read(path),
          gitRequired: false,
        };
      },
      async read(path) {
        return { path: `${path}/rig.yaml`, revision: "r1", config };
      },
      async initialize(path) {
        return await this.read(path);
      },
      async rename() {
        throw new Error("unused");
      },
      resolve: (input) =>
        resolveTargetPlan(input, {
          operatorHome: "/home/operator",
          envRoot: "/rig/env",
        }),
      async host() {
        return parseHostConfig({});
      },
    },
    sources: {
      async preflight() {
        return { commit: "c1", warnings: [] };
      },
      async prepare(request) {
        return { workspacePath: request.destination, commit: request.ref };
      },
      async resolve(_repository, ref) {
        return ref;
      },
      async currentBranch() {
        return "main";
      },
      async release() {},
    },
    lifecycle: createTargetLifecycle(effects, {
      schedule(delayMs, fire) {
        const timer = setTimeout(fire, Math.min(delayMs, 1));
        return () => clearTimeout(timer);
      },
      startGraceMs: 0,
    }),
    observations: {
      async process(target, component) {
        return running.has(`${target.id}:${component.name}`)
          ? { state: "running", pid: 42 }
          : { state: "stopped" };
      },
      async health() {
        return { ready: true };
      },
      async artifact() {
        return "missing";
      },
      async listening() {
        return [];
      },
      async persistent() {
        return true;
      },
    },
    files: {
      async destroyPreview() {},
      async inspectPreviewDeletion() {},
      async selectPorts(input) {
        return Object.fromEntries(
          input.requests.map((request, index) => [request.name, 5000 + index]),
        );
      },
      async logs() {
        return { entries: [], cursor: "0" };
      },
    },
    observationBudgetMs: 2000,
    observationDeadline: controlledDeadline(),
    now: () => new Date(clock).toISOString(),
    id: () => `id${++id}`,
    async diagnostic() {},
  };
  const runtime = createRuntime(deps);
  /** Waits until the supervisor holds a stop of `service`, and returns it. */
  const stopOf = async (service: string): Promise<HeldStop> => {
    for (let i = 0; i < 1000; i++) {
      const found = held.find((stop) => stop.key.endsWith(`:${service}`));
      if (found) {
        held.splice(held.indexOf(found), 1);
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(
      `no stop of ${service} was asked for; stops so far: ${JSON.stringify(stops)}`,
    );
  };
  return {
    runtime,
    state,
    stops,
    running,
    failing,
    stopOf,
    hold: (on = true) => {
      holding = on;
    },
    /** Holds every preparation until the returned release is called. */
    holdPreparation: () => {
      let release!: () => void;
      preparing = new Promise((resolve) => (release = resolve));
      return () => {
        preparing = undefined;
        release();
      };
    },
    advance: (ms: number) => {
      clock += ms;
    },
    command: (command: Parameters<typeof runtime.command>[0]) =>
      runtime.command({ project: "fletcher", ...command }),
    queue: (operation: string) =>
      runtime.command({ action: "queue", operation }) as Promise<{
        operation: Record<string, unknown>;
      }>,
  };
}

async function registered() {
  const w = world();
  await w.runtime.command({ action: "init", repoPath: "/tmp/fletcher" });
  return w;
}

test("rig down waits for each Service's stop_timeout, shows it on the Operation and in status, and records a SIGKILL in Activity and status", async () => {
  const w = await registered();
  await w.command({ action: "up", target: "local" });
  w.hold();
  const down = w.command({
    action: "down",
    target: "local",
    operationId: "down-1",
  });
  // Reverse dependency order: worker (25m) first.
  const worker = await w.stopOf("worker");
  expect(worker.request.graceMs).toBe(25 * 60_000);
  const position = (await w.queue("down-1")).operation;
  expect(position).toMatchObject({
    state: "running",
    phase: "stopping",
    project: "fletcher",
    target: "local",
    stops: [
      {
        service: "worker",
        target: "local",
        state: "stopping",
        since: "2026-09-27T04:00:00.000Z",
        killAt: "2026-09-27T04:25:00.000Z",
      },
    ],
  });
  const status = await w.runtime.status({
    project: "fletcher",
    target: "local",
  });
  expect(status.targets[0]).toMatchObject({ state: "stopping" });
  expect(
    status.targets[0]!.components.find((c) => c.name === "worker"),
  ).toMatchObject({ state: "stopping", killAt: "2026-09-27T04:25:00.000Z" });
  w.advance(25 * 60_000);
  worker.exit("timeout");
  const web = await w.stopOf("web");
  expect(web.request.graceMs).toBe(120_000);
  w.advance(6_000);
  web.exit();
  const result = (await down) as { outcome: string; stops: unknown[] };
  expect(result.outcome).toBe("stopped");
  expect(result.stops).toEqual([
    {
      service: "worker",
      target: "local",
      state: "stopped",
      since: "2026-09-27T04:00:00.000Z",
      killAt: "2026-09-27T04:25:00.000Z",
      endedAt: "2026-09-27T04:25:00.000Z",
      killed: "timeout",
    },
    {
      service: "web",
      target: "local",
      state: "stopped",
      since: "2026-09-27T04:25:00.000Z",
      killAt: "2026-09-27T04:27:00.000Z",
      endedAt: "2026-09-27T04:25:06.000Z",
    },
  ]);
  expect(w.state.activity.at(-1)).toMatchObject({
    action: "down",
    outcome: "stopped",
    message: "worker stopped after timeout (SIGKILL)",
  });
  const after = await w.runtime.status({
    project: "fletcher",
    target: "local",
  });
  expect(
    after.targets[0]!.components.find((c) => c.name === "worker"),
  ).toMatchObject({
    state: "stopped",
    exit: "requested",
    signal: "SIGKILL",
    reason:
      "Stopped after timeout (SIGKILL): it did not exit within its stop_timeout.",
  });
  expect(
    after.targets[0]!.components.find((c) => c.name === "web"),
  ).toMatchObject({ state: "stopped", exit: "requested" });
  expect(
    after.targets[0]!.components.find((c) => c.name === "web")!.reason,
  ).toBeUndefined();
});

test("a rig down or rig restart that fails part-way still records the SIGKILL of a Service it stopped before, in status and Activity", async () => {
  for (const action of ["down", "restart"] as const) {
    const w = await registered();
    await w.command({ action: "up", target: "local" });
    w.hold();
    const stopping = w.command({
      action,
      target: "local",
      operationId: `${action}-2`,
    });
    const worker = await w.stopOf("worker");
    w.advance(25 * 60_000);
    worker.exit("timeout");
    const web = await w.stopOf("web");
    web.fail(new Error("the supervisor lost the process"));
    await expect(stopping).rejects.toMatchObject({ code: "STOP_INCOMPLETE" });
    expect(w.state.activity.at(-1)).toMatchObject({
      action,
      outcome: "failed",
      message: "STOP_INCOMPLETE: worker stopped after timeout (SIGKILL)",
    });
    const after = await w.runtime.status({
      project: "fletcher",
      target: "local",
    });
    expect(
      after.targets[0]!.components.find((c) => c.name === "worker"),
    ).toMatchObject({
      reason:
        "Stopped after timeout (SIGKILL): it did not exit within its stop_timeout.",
    });
  }
});

test("the first pass's stop of a Target meant to be stopped that fails part-way still records the SIGKILL of a Service it stopped before", async () => {
  const w = await registered();
  await w.command({ action: "up", target: "local" });
  w.state.targets[0]!.desired = "stopped";
  w.hold();
  const pass = w.runtime.reconcile();
  const worker = await w.stopOf("worker");
  w.advance(25 * 60_000);
  worker.exit("timeout");
  (await w.stopOf("web")).fail(new Error("the supervisor lost the process"));
  await pass;
  const after = await w.runtime.status({
    project: "fletcher",
    target: "local",
  });
  expect(
    after.targets[0]!.components.find((c) => c.name === "worker"),
  ).toMatchObject({
    reason:
      "Stopped after timeout (SIGKILL): it did not exit within its stop_timeout.",
  });
});

test("a rig restart that stopped a Service with SIGKILL and then failed before starting it again still says so in status", async () => {
  const w = await registered();
  await w.command({ action: "up", target: "local" });
  w.hold();
  const release = w.holdPreparation();
  w.failing.add("web");
  const restart = w.command({
    action: "restart",
    target: "local",
    operationId: "restart-3",
  });
  const worker = await w.stopOf("worker");
  w.advance(25 * 60_000);
  worker.exit("timeout");
  (await w.stopOf("web")).exit();
  release();
  await expect(restart).rejects.toBeDefined();
  const after = await w.runtime.status({
    project: "fletcher",
    target: "local",
  });
  expect(
    after.targets[0]!.components.find((c) => c.name === "worker"),
  ).toMatchObject({
    state: "stopped",
    reason:
      "Stopped after timeout (SIGKILL): it did not exit within its stop_timeout.",
  });
});

test("rig restart waits for the stop_timeout before it starts the Services again", async () => {
  const w = await registered();
  await w.command({ action: "up", target: "local" });
  w.hold();
  const restart = w.command({
    action: "restart",
    target: "local",
    operationId: "restart-1",
  });
  const worker = await w.stopOf("worker");
  expect(worker.request.graceMs).toBe(25 * 60_000);
  expect((await w.queue("restart-1")).operation).toMatchObject({
    phase: "stopping",
  });
  worker.exit();
  const web = await w.stopOf("web");
  expect(web.request.graceMs).toBe(120_000);
  // Nothing starts while a Service is still within its grace.
  expect(w.running.size).toBe(1);
  web.exit();
  expect(await restart).toMatchObject({ outcome: "started" });
  expect(w.running.size).toBe(2);
});

test("a deploy that replaces the Stable Target waits for the previous release's stop_timeout, marked stopping, then goes on deploying", async () => {
  const w = await registered();
  await w.command({ action: "deploy", target: "live", branch: "main" });
  w.hold();
  const deploy = w.command({
    action: "deploy",
    target: "live",
    branch: "main",
    commit: "c2",
    operationId: "deploy-2",
  });
  const worker = await w.stopOf("worker");
  expect(worker.request.graceMs).toBe(25 * 60_000);
  expect((await w.queue("deploy-2")).operation).toMatchObject({
    phase: "stopping",
    stops: [{ service: "worker", state: "stopping" }],
  });
  const status = await w.runtime.status({
    project: "fletcher",
    target: "live",
  });
  expect(status.targets[0]!.state).toBe("stopping");
  worker.exit();
  const web = await w.stopOf("web");
  expect(web.request.graceMs).toBe(120_000);
  web.exit();
  expect(await deploy).toMatchObject({ outcome: "deployed", commit: "c2" });
});

test("a deploy rollback and the failed start before it each stop within the Services' stop_timeout", async () => {
  const w = await registered();
  await w.command({ action: "deploy", target: "live", branch: "main" });
  w.failing.add("worker");
  w.hold();
  const deploy = w.command({
    action: "deploy",
    target: "live",
    branch: "main",
    commit: "c2",
    operationId: "deploy-2",
  });
  // The previous release is stopped for the candidate…
  (await w.stopOf("worker")).exit();
  (await w.stopOf("web")).exit();
  // …whose web starts, and is stopped again when its worker cannot start: the failed start's rollback, marked stopping.
  const rollback = await w.stopOf("web");
  expect(rollback.request.graceMs).toBe(120_000);
  expect((await w.queue("deploy-2")).operation).toMatchObject({
    phase: "stopping",
  });
  rollback.exit();
  await expect(deploy).rejects.toThrow();
  // The previous release is started again once the rollback's stops are done.
  expect(w.stops.map((stop) => [stop.key.split(":")[1], stop.graceMs])).toEqual(
    [
      ["worker", 1_500_000],
      ["web", 120_000],
      ["web", 120_000],
    ],
  );
});

test("a Preview destroy waits for the Preview's stop_timeout before its storage is deleted", async () => {
  const w = await registered();
  await w.command({
    action: "deploy",
    target: "preview",
    branch: "feature",
    deployment: "feature",
  });
  w.hold();
  const destroy = w.command({
    action: "destroy",
    target: "preview",
    deployment: "feature",
    operationId: "destroy-1",
  });
  const worker = await w.stopOf("worker");
  expect(worker.request.graceMs).toBe(25 * 60_000);
  expect((await w.queue("destroy-1")).operation).toMatchObject({
    phase: "stopping",
    target: "feature",
  });
  expect(w.state.targets.some((t) => t.name === "feature")).toBe(true);
  worker.exit();
  (await w.stopOf("web")).exit();
  await destroy;
  expect(w.state.targets.some((t) => t.name === "feature")).toBe(false);
});

test("rig down --kill cuts a stop already running on the Target short, then runs its own", async () => {
  const w = await registered();
  await w.command({ action: "up", target: "local" });
  w.hold();
  const down = w.command({
    action: "down",
    target: "local",
    operationId: "down-1",
  });
  const worker = await w.stopOf("worker");
  expect(worker.request.kill?.aborted).toBe(false);
  w.advance(60_000);
  const kill = w.command({
    action: "down",
    target: "local",
    kill: true,
    operationId: "down-kill",
  });
  for (let i = 0; i < 100 && !worker.request.kill?.aborted; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(worker.request.kill?.aborted).toBe(true);
  // The running stop now shows SIGKILL due after the kill wait.
  expect((await w.queue("down-1")).operation).toMatchObject({
    stops: [{ service: "worker", killAt: "2026-09-27T04:01:01.500Z" }],
  });
  worker.exit("request");
  // The rest of the running stop is a kill too.
  const web = await w.stopOf("web");
  expect(web.request.kill?.aborted).toBe(true);
  web.exit();
  await down;
  expect(await kill).toMatchObject({ outcome: "unchanged" });
  expect(w.state.activity.at(-2)).toMatchObject({
    message: "worker was killed by --kill (SIGKILL)",
  });
});

test("rig down --kill on a running Target stops every Service with its kill already asked", async () => {
  const w = await registered();
  await w.command({ action: "up", target: "local" });
  await w.command({ action: "down", target: "local", kill: true });
  expect(w.stops.map((stop) => stop.kill)).toEqual([true, true]);
});

test("rigd's drain does not wait out a long grace: the stop detaches and the command fails STOP_DETACHED", async () => {
  const w = await registered();
  await w.command({ action: "up", target: "local" });
  w.hold();
  const down = w.command({ action: "down", target: "local" });
  await w.stopOf("worker");
  const drained = w.runtime.drain();
  await expect(down).rejects.toMatchObject({ code: "STOP_DETACHED" });
  await drained;
  // The Target was recorded stopped before the wait, so the next daemon's first pass finishes the stop.
  expect(w.state.targets[0]!.desired).toBe("stopped");
});

test("the next daemon's first pass stops a Target meant to be stopped within its stop_timeout, marked stopping", async () => {
  const w = await registered();
  await w.command({ action: "up", target: "local" });
  w.state.targets[0]!.desired = "stopped";
  w.hold();
  const pass = w.runtime.reconcile();
  const worker = await w.stopOf("worker");
  expect(worker.request.graceMs).toBe(25 * 60_000);
  const status = await w.runtime.status({
    project: "fletcher",
    target: "local",
  });
  expect(
    status.targets[0]!.components.find((c) => c.name === "worker"),
  ).toMatchObject({ state: "stopping", killAt: "2026-09-27T04:25:00.000Z" });
  worker.exit();
  (await w.stopOf("web")).exit();
  await pass;
});

test("rig down --kill sent while a deploy is still building cuts the grace of the stop that deploy makes later", async () => {
  const w = await registered();
  await w.command({ action: "deploy", target: "live", branch: "main" });
  const release = w.holdPreparation();
  const deploy = w.command({
    action: "deploy",
    target: "live",
    branch: "main",
    commit: "c2",
    operationId: "deploy-2",
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const kill = w.command({ action: "down", target: "live", kill: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  await deploy;
  await kill;
  // The deploy's stop of the previous release, then the kill's own stop of the new one: all without the grace.
  expect(w.stops.map((stop) => stop.kill)).toEqual([true, true, true, true]);
  // Once the kill is over, stops wait out their grace again.
  await w.command({ action: "up", target: "live" });
  await w.command({ action: "down", target: "live" });
  expect(w.stops.slice(4).map((stop) => stop.kill)).toEqual([false, false]);
});

test("a kill is refused on commands other than down and restart", async () => {
  const w = await registered();
  await expect(
    w.command({ action: "up", target: "local", kill: true }),
  ).rejects.toMatchObject({ code: "USAGE" });
});
