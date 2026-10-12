import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseProjectConfig } from "../src/config";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import { monitoredProcesses } from "../src/runtime/monitored-processes";
import type { UsageMonitor } from "../src/runtime/usage-report";
import { runtimeWorld } from "./support/runtime-world";

// Monitor (#345) in the runtime: which processes the sampler is given, how `monitor` reads are scoped, and `rig forget`
// removing a Project's history.

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(usage?: UsageMonitor) {
  const config = parseProjectConfig({
    name: "demo",
    services: { web: { command: "serve" }, worker: { command: "work" } },
    jobs: { crawl: { command: "crawl", schedule: "0 3 * * *" } },
    targets: { working: true },
  });
  const processes = new Map<string, ProcessObservation>();
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      processes.set(request.key, {
        state: "running",
        pid: 4000 + processes.size,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      const running = processes.get(key)?.state === "running";
      processes.delete(key);
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const world = await runtimeWorld({
    name: "monitor",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-12T08:00:00.000Z",
    readinessDeadlineMs: 2000,
    ...(usage
      ? { dependencies: (): Partial<RuntimeDependencies> => ({ usage }) }
      : {}),
  });
  roots.push(world.root);
  const runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  return { world, runtime, processes };
}

/** A Monitor that records what it is asked and answers with an empty report. */
function recordingMonitor(options: { failForget?: boolean } = {}) {
  const asked: unknown[] = [];
  const forgotten: string[] = [];
  const monitor: UsageMonitor = {
    async report(request) {
      asked.push(request);
      return {
        since: request.window.since,
        from: 0,
        to: 3600,
        step: 15,
        sampledEvery: 1,
        series: [],
      };
    },
    async forget(projectId) {
      if (options.failForget) throw new Error("database is locked");
      forgotten.push(projectId);
    },
  };
  return { monitor, asked, forgotten };
}

test("the sampler is given every running Service, with the capture wrapper's pid and the Target it runs on", async () => {
  const { world, runtime, processes } = await fixture();
  expect(
    await monitoredProcesses({
      ...world.deps,
      signal: new AbortController().signal,
    }),
  ).toEqual([]);
  await runtime.command({ action: "up", project: "demo", target: "working" });
  // A Job run in progress is sampled too, under the job's own key.
  const target = (await world.store.read()).targets[0]!;
  processes.set(`${target.id}:job:crawl`, { state: "running", pid: 4999 });

  const sampled = await monitoredProcesses({
    ...world.deps,
    signal: new AbortController().signal,
  });
  expect(
    sampled
      .map(
        (each) =>
          `${each.series.componentKind} ${each.series.component} ${each.wrapperPid}`,
      )
      .sort(),
  ).toEqual(["job crawl 4999", "service web 4000", "service worker 4001"]);
  expect(sampled[0]!.series).toMatchObject({
    project: "demo",
    target: "working",
    targetKind: "working",
    targetId: target.id,
  });

  await runtime.command({ action: "down", project: "demo", target: "working" });
  expect(
    await monitoredProcesses({
      ...world.deps,
      signal: new AbortController().signal,
    }),
  ).toEqual([]);
});

test("monitor reads one Project by its identity, or the whole Host when asked, over the window asked (the last hour by default)", async () => {
  const usage = recordingMonitor();
  const { world, runtime } = await fixture(usage.monitor);
  const projectId = (await world.store.read()).projects[0]!.id;
  const seconds = (iso: string) => Date.parse(iso) / 1000;

  const project = await runtime.command({
    action: "monitor",
    repoPath: world.repo,
  });
  expect(project).toMatchObject({ project: "demo" });
  await runtime.command({
    action: "monitor",
    host: true,
    window: {
      since: "2026-10-11T06:00:00.000Z",
      until: "2026-10-11T09:30:00.000Z",
    },
  });
  expect(usage.asked).toEqual([
    {
      filter: { kind: "project", projectId },
      window: { since: seconds("2026-10-12T07:00:00.000Z") },
    },
    {
      filter: { kind: "host" },
      window: {
        since: seconds("2026-10-11T06:00:00.000Z"),
        until: seconds("2026-10-11T09:30:00.000Z"),
      },
    },
  ]);
  await expect(
    runtime.command({
      action: "monitor",
      host: true,
      window: {
        since: "2026-10-11T09:30:00.000Z",
        until: "2026-10-11T09:30:00.000Z",
      },
    }),
  ).rejects.toMatchObject({ code: "USAGE" });
  // Instants keep their milliseconds: a window inside one second is still a window.
  await runtime.command({
    action: "monitor",
    host: true,
    window: {
      since: "2026-10-11T09:30:00.100Z",
      until: "2026-10-11T09:30:00.900Z",
    },
  });
  expect(usage.asked.at(-1)!.window).toEqual({
    since: seconds("2026-10-11T09:30:00.100Z"),
    until: seconds("2026-10-11T09:30:00.900Z"),
  });
});

test("a rigd that samples nothing refuses monitor with a hint, rather than reporting no use", async () => {
  const { runtime } = await fixture();
  await expect(
    runtime.command({ action: "monitor", host: true }),
  ).rejects.toMatchObject({ code: "MONITOR_UNAVAILABLE" });
});

test("forgetting a Project removes its CPU and memory history, and a removal that fails is a warning, not a failed forget", async () => {
  const usage = recordingMonitor();
  const { world, runtime } = await fixture(usage.monitor);
  const projectId = (await world.store.read()).projects[0]!.id;
  await runtime.command({ action: "forget", project: "demo" });
  expect(usage.forgotten).toEqual([projectId]);

  const failing = recordingMonitor({ failForget: true });
  const second = await fixture(failing.monitor);
  const reply = (await second.runtime.command({
    action: "forget",
    project: "demo",
  })) as { warnings?: string[] };
  expect((await second.world.store.read()).projects).toEqual([]);
  expect(reply.warnings).toEqual(
    expect.arrayContaining([
      expect.stringContaining("CPU and memory history could not be removed"),
    ]),
  );
});
