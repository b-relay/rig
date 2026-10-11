import { afterEach, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { ServiceRun, TargetRecord } from "../src/domain/runtime";
import { serviceDefinition } from "../src/domain/service-definition";
import { runtimeWorld } from "./support/runtime-world";

/** ADR 0016 through the real runtime, lifecycle and state file, over a scripted supervisor and scripted deployment sources:
 * what a start records, which Services a deploy keeps running, and when a checkout a kept process runs in is given back. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** Melody's shape: db (Postgres via a script in the repository), search (Typesense, an absolute binary), api on both, and
 * web on api. */
function melody(services: Record<string, Record<string, unknown>> = {}) {
  return parseProjectConfig({
    name: "melody",
    environment: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
    services: {
      db: { command: "sh scripts/rig-postgres.sh", ...services.db },
      search: {
        command: "/opt/typesense/bin/typesense-server",
        ...services.search,
      },
      api: {
        command: "node api.js",
        depends_on: ["db", "search"],
        ...services.api,
      },
      web: { command: "node web.js", depends_on: ["api"], ...services.web },
    },
    targets: { working: true, stable: true },
  });
}

async function fixture(config: ProjectConfig = melody()) {
  const processes = new Map<string, ProcessObservation>();
  let pid = 5000;
  /** Every spawn and stop, by Service name, in order. */
  const events: string[] = [];
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
      events.push(`start ${request.componentName}`);
      processes.set(request.key, {
        state: "running",
        pid: ++pid,
        incarnation: request.incarnation,
      });
      return { outcome: "started" };
    },
    async stop(key) {
      const running = processes.get(key)?.state === "running";
      if (running) events.push(`stop ${key.split(":").at(-1)}`);
      processes.set(key, { state: "stopped" });
      return { outcome: running ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  /** The Commit the Production branch points at; a test moves it. */
  const git = {
    head: "c1",
    /** Whether `paths` (undefined: the whole tree) changed between two Commits. */
    changed: (_from: string, _to: string, _paths?: readonly string[]) => true,
  };
  const released: string[] = [];
  const world = await runtimeWorld({
    name: "keep",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-11T09:00:00.000Z",
    readinessDeadlineMs: 2000,
    dependencies: () => ({
      sources: {
        async preflight() {
          return { commit: git.head, warnings: [] };
        },
        async resolve() {
          return git.head;
        },
        async currentBranch() {
          return "main";
        },
        async prepare(request: { destination: string }) {
          await mkdir(request.destination, { recursive: true });
          return { workspacePath: request.destination, commit: git.head };
        },
        async release({ workspacePath }: { workspacePath: string }) {
          released.push(workspacePath);
          await rm(workspacePath, { recursive: true, force: true });
        },
        async changed(request: {
          from: string;
          to: string;
          paths?: readonly string[];
        }) {
          if (request.paths?.length === 0) return false;
          return git.changed(request.from, request.to, request.paths);
        },
      } as unknown as RuntimeDependencies["sources"],
    }),
  });
  roots.push(world.root);
  const runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  const stable = async (): Promise<TargetRecord> =>
    (await world.store.read()).targets.find((t) => t.kind === "stable")!;
  const pids = async () => {
    const target = await stable();
    return Object.fromEntries(
      ["db", "search", "api", "web"].map((name) => [
        name,
        processes.get(`${target.id}:${name}`)?.pid,
      ]),
    );
  };
  const deploy = (extra: Record<string, unknown> = {}) =>
    runtime.command({
      action: "deploy",
      repoPath: world.repo,
      target: "stable",
      branch: "main",
      ...extra,
    }) as Promise<Record<string, unknown>>;
  return {
    world,
    runtime,
    processes,
    events,
    git,
    released,
    stable,
    pids,
    deploy,
    config,
  };
}

test("every start records where its process runs: the checkout, its Commit, the definition and a keyed environment digest", async () => {
  const f = await fixture();
  await f.deploy();
  const target = await f.stable();
  const run = target.services!.db as ServiceRun;
  const db = target.plan.components.find((c) => c.name === "db")!;
  expect(run.source).toEqual({
    checkout: target.plan.workspacePath,
    commit: "c1",
    definition: serviceDefinition(
      target.plan,
      db as Parameters<typeof serviceDefinition>[1],
    ),
    environment: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  // The digest is what a start would record now, so an unchanged environment compares equal.
  expect(await f.world.deps.lifecycle.environmentDigest(target, "db")).toBe(
    run.source!.environment!,
  );
  // The working Target's starts record its checkout, the repository itself, without a Commit.
  await f.runtime.command({ action: "up", repoPath: f.world.repo });
  const working = (await f.world.store.read()).targets.find(
    (t) => t.kind === "working",
  )!;
  expect(working.services!.web!.source).toMatchObject({
    checkout: f.world.repo,
  });
  expect(working.services!.web!.source).not.toHaveProperty("commit");
});
