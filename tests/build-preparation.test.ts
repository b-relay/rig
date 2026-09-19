import { localActivation } from "./support/activation-doubles";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTargetEffects } from "../src/adapters/target-effects";
import { createArtifactInstaller } from "../src/providers/artifact-installer";
import { runCommand } from "../src/providers/command-runner";
import { createCaddyRouter } from "../src/providers/caddy-router";
import {
  assertSourceBuildsKnown,
  createTargetLifecycle,
} from "../src/runtime/lifecycle";
import { activateDeployment, stopForRecovery } from "../src/runtime/deploy";
import { prepareTarget, unitPolicy } from "../src/runtime/preparation";
import type { BuildUnit } from "../src/config/types";
import type { RuntimeState, TargetRecord } from "../src/domain/runtime";
import type { RuntimeDependencies } from "../src/runtime/contracts";
import type { Supervisor } from "../src/providers/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** Real effects over a fake supervisor and an in-memory store whose writes a test can fail.
 * Each build appends its unit id to `<root>/order`, so the file is the run order across deployments. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-build-preparation-"));
  roots.push(root);
  for (const revision of ["old", "new"]) {
    await mkdir(join(root, revision));
    await writeFile(
      join(root, revision, "tool"),
      `#!/bin/sh\necho ${revision}\n`,
    );
  }
  const running = new Set<string>();
  /** Every process start and stop the supervisor was asked for. */
  const transitions: string[] = [];
  const supervisor: Supervisor = {
    async observe(key) {
      return running.has(key)
        ? { state: "running", pid: 1 }
        : { state: "stopped" };
    },
    async ensureRunning(request) {
      transitions.push(`start ${request.key}`);
      running.add(request.key);
      return { outcome: "started" };
    },
    async stop(key) {
      transitions.push(`stop ${key}`);
      return { outcome: running.delete(key) ? "stopped" : "unchanged" };
    },
    async shutdown() {},
    async detach() {},
  };
  const effects = createTargetEffects({
    ...localActivation([12345, 12346]),
    recordingTime: () => new Date().toISOString(),
    root,
    environment: {},
    supervisors: new Map([["child", supervisor]]),
    installer: createArtifactInstaller({
      run: runCommand,
      bunExecutable: process.execPath,
    }),
    router: createCaddyRouter({
      caddyfile: join(root, "Caddyfile"),
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }),
    run: runCommand,
  });
  const lifecycle = createTargetLifecycle(effects);
  const order = join(root, "order");
  const unit = (id: string, component?: string, extra = ""): BuildUnit => ({
    id,
    ...(component ? { component } : {}),
    command: `echo ${id} >> '${order}'${extra}`,
    timeout: 60,
  });
  const common = { env: {}, dependsOn: [] as string[] };
  const previous: TargetRecord = {
    id: "target",
    projectId: "project",
    name: "live",
    kind: "live",
    branch: "main",
    commit: "old",
    desired: "stopped",
    createdAt: "now",
    updatedAt: "now",
    logRoot: join(root, "logs"),
    plan: {
      project: "demo",
      target: "live",
      workspacePath: join(root, "old"),
      dataRoot: join(root, "data"),
      deploymentName: "live",
      branchSlug: "live",
      subdomain: "live",
      providerProfile: "default",
      providers: { processSupervisor: "child" },
      components: [
        {
          ...common,
          name: "api",
          kind: "managed",
          command: "unused",
          port: 12346,
          readyTimeout: 1,
        },
        {
          ...common,
          dependsOn: ["api"],
          name: "web",
          kind: "managed",
          command: "unused",
          port: 12345,
          readyTimeout: 1,
        },
        { ...common, name: "tool", kind: "installed", entrypoint: "tool" },
      ],
      builds: [
        unit("shared"),
        unit("service:api", "api"),
        unit("service:web", "web"),
        unit("tool:tool", "tool"),
      ],
      preparedComponents: [],
      domain: "old.test",
      proxy: { upstream: "web" },
    },
  };
  const candidate = structuredClone(previous);
  candidate.commit = "new";
  candidate.plan.workspacePath = join(root, "new");
  candidate.plan.domain = "new.test";
  const state: RuntimeState = {
    version: 4,
    projects: [],
    targets: [],
    activity: [],
  };
  /** Set to make the store refuse the next write whose Target matches. */
  const refusal: { when?: (target: TargetRecord) => boolean } = {};
  const deps = {
    lifecycle,
    now: () => "then",
    id: () => crypto.randomUUID(),
    store: {
      async read() {
        return structuredClone(state);
      },
      async update(change: (state: RuntimeState) => void | Promise<void>) {
        const next = structuredClone(state);
        await change(next);
        if (next.targets.some((target) => refusal.when?.(target))) {
          delete refusal.when;
          throw new Error("store refused the write");
        }
        Object.assign(state, next);
      },
    },
  } as RuntimeDependencies;
  const ran = async () =>
    (await readFile(order, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return {
    root,
    previous,
    candidate,
    lifecycle,
    state,
    deps,
    running,
    transitions,
    refusal,
    unit,
    ran,
  };
}
const ALL = ["shared", "service:api", "service:web", "tool:tool"];

test("a prepare-only deployment builds every unit in plan order, starts no Service, publishes no route, and up then starts it without building", async () => {
  const f = await fixture();
  const deployed = await activateDeployment(
    f.candidate,
    undefined,
    { activation: "prepare" },
    f.deps,
  );
  expect(await f.ran()).toEqual(ALL);
  expect(f.running.size).toBe(0);
  expect(
    await readFile(join(f.root, "Caddyfile"), "utf8").catch(() => ""),
  ).toBe("");
  expect(
    Object.values(deployed.preparation!.units).map((unit) => unit.state),
  ).toEqual(ALL.map(() => "succeeded"));
  expect(deployed.preparation!.units["shared"]).toMatchObject({
    commit: "new",
    startedAt: "then",
    finishedAt: "then",
    policy: unitPolicy(f.candidate.plan.builds![0]!, f.candidate.plan),
  });
  await f.lifecycle.up(deployed);
  expect([...f.running].sort()).toEqual(["target:api", "target:web"]);
  expect(await f.ran()).toEqual(ALL);
});

test("a failed build leaves the running previous Deployment untouched, keeps the units that succeeded, and refuses to start the failed one", async () => {
  const f = await fixture();
  const previous = await activateDeployment(
    f.previous,
    undefined,
    { activation: "start" },
    f.deps,
  );
  expect([...f.running].sort()).toEqual(["target:api", "target:web"]);
  f.candidate.plan.builds![2] = f.unit("service:web", "web", "; exit 7");
  f.transitions.length = 0;
  await expect(
    activateDeployment(f.candidate, previous, { activation: "start" }, f.deps),
  ).rejects.toMatchObject({
    code: "BUILD_FAILED",
    details: { unit: "service:web", exitCode: 7 },
  });
  // Later units never ran, and the previous Services were never stopped or restarted: the candidate shares their process keys.
  expect(f.transitions).toEqual([]);
  expect((await f.ran()).slice(4)).toEqual([
    "shared",
    "service:api",
    "service:web",
  ]);
  expect([...f.running].sort()).toEqual(["target:api", "target:web"]);
  expect(f.state.targets[0]).toMatchObject({
    commit: "old",
    plan: { workspacePath: join(f.root, "old") },
  });
  expect(f.candidate.preparation!.units).toMatchObject({
    shared: { state: "succeeded" },
    "service:api": { state: "succeeded" },
    "service:web": { state: "failed" },
  });
  expect(f.candidate.preparation!.units["tool:tool"]).toBeUndefined();
  await expect(f.lifecycle.up(f.candidate)).rejects.toMatchObject({
    code: "PREPARATION_INCOMPLETE",
    details: { unit: "service:web" },
    hint: expect.stringContaining("rig deploy live --force"),
  });
});

test("a build past its budget fails the deployment as BUILD_TIMEOUT and is recorded as failed", async () => {
  const f = await fixture();
  f.candidate.plan.builds = [
    { ...f.unit("shared", undefined, "; sleep 30"), timeout: 1 },
  ];
  await expect(
    activateDeployment(
      f.candidate,
      undefined,
      { activation: "prepare" },
      f.deps,
    ),
  ).rejects.toMatchObject({
    code: "BUILD_TIMEOUT",
    details: { unit: "shared", timeoutSeconds: 1 },
  });
  expect(f.candidate.preparation!.units["shared"]!.state).toBe("failed");
}, 15000);

test("a build whose success could not be recorded is unknown: nothing reruns it, up is refused, and only a new workspace is a fresh scope", async () => {
  const f = await fixture();
  f.refusal.when = (target) =>
    target.preparation?.units["service:api"]?.state === "succeeded";
  await expect(
    activateDeployment(
      f.candidate,
      undefined,
      { activation: "prepare" },
      f.deps,
    ),
  ).rejects.toMatchObject({
    code: "BUILD_UNKNOWN",
    details: { unit: "service:api" },
  });
  expect(await f.ran()).toEqual(["shared", "service:api"]);
  // What a reopened daemon reads: the unit started and was never recorded as finished.
  const recorded = structuredClone(f.state.targets[0]!);
  expect(recorded.preparation!.units["service:api"]!.state).toBe("started");
  await expect(f.lifecycle.up(recorded)).rejects.toMatchObject({
    code: "BUILD_UNKNOWN",
    details: { unit: "service:api" },
    hint: expect.stringContaining("rig deploy live --force"),
  });
  expect(await f.ran()).toEqual(["shared", "service:api"]);
  // A forced deployment of the same Commit is planned into a new workspace, which owes nothing to the old record.
  const forced = structuredClone(recorded);
  forced.plan.workspacePath = join(f.root, "old");
  delete forced.recovery;
  const deployed = await activateDeployment(
    forced,
    recorded,
    { activation: "start" },
    f.deps,
  );
  expect((await f.ran()).slice(2)).toEqual(ALL);
  expect(deployed.preparation).toMatchObject({
    deployment: join(f.root, "old"),
    units: { "service:api": { state: "succeeded" } },
  });
});

test("a replacement whose build outcome is unknown rolls back to the running Deployment and still gates a plain deploy of that source", async () => {
  const f = await fixture();
  const previous = await activateDeployment(
    f.previous,
    undefined,
    { activation: "start" },
    f.deps,
  );
  f.transitions.length = 0;
  f.refusal.when = (target) =>
    target.preparation?.units["service:api"]?.state === "succeeded";
  await expect(
    activateDeployment(f.candidate, previous, { activation: "start" }, f.deps),
  ).rejects.toMatchObject({ code: "BUILD_UNKNOWN" });
  expect(f.transitions).toEqual([]);
  // What a reopened daemon reads: the previous Deployment, and the source whose build is uncertain.
  const recorded = structuredClone(f.state.targets[0]!);
  expect(recorded).toMatchObject({
    commit: "old",
    uncertainBuild: { branch: "main", commit: "new", unit: "service:api" },
  });
  expect(() =>
    assertSourceBuildsKnown(recorded, { branch: "main", commit: "new" }),
  ).toThrow(expect.objectContaining({ code: "BUILD_UNKNOWN" }));
  assertSourceBuildsKnown(recorded, { branch: "main", commit: "other" });
  // The next completed deployment is planned fresh and carries no such mark.
  const forced = structuredClone(f.candidate);
  delete forced.preparation;
  delete forced.recovery;
  forced.plan.workspacePath = join(f.root, "old");
  const deployed = await activateDeployment(
    forced,
    recorded,
    { activation: "prepare" },
    f.deps,
  );
  expect(deployed.uncertainBuild).toBeUndefined();
});

test("recovering a failed replacement restores the previous Deployment's preparation, so it starts again without building", async () => {
  const f = await fixture();
  const previous = await activateDeployment(
    f.previous,
    undefined,
    { activation: "prepare" },
    f.deps,
  );
  // The candidate's record is what a crash mid-build leaves behind: pending recovery over an unknown unit.
  f.refusal.when = (target) =>
    target.preparation?.units["shared"]?.state === "succeeded";
  const interrupted = structuredClone(f.candidate);
  interrupted.recovery = {
    plan: previous.plan,
    preparation: previous.preparation,
    branch: previous.branch,
    commit: previous.commit,
    desired: "stopped",
    stage: "pending",
  };
  await expect(prepareTarget(interrupted, "all", f.deps)).rejects.toMatchObject(
    { code: "BUILD_UNKNOWN" },
  );
  const recovered = await stopForRecovery(interrupted, f.deps);
  expect(recovered.preparation).toEqual(previous.preparation);
  // The abandoned attempt's uncertainty outlives its record.
  expect(recovered.uncertainBuild).toEqual({
    branch: "main",
    commit: "new",
    unit: "shared",
  });
  await f.lifecycle.up(recovered);
  expect((await f.ran()).slice(4)).toEqual(["shared"]);
});

test("a Working copy up builds the units of stopped Services and every Tool, nothing once all Services run and no Tool exists, and restart builds all", async () => {
  const f = await fixture();
  const local: TargetRecord = {
    ...structuredClone(f.previous),
    kind: "local",
    name: "local",
    plan: { ...structuredClone(f.previous.plan), target: "local" },
  };
  expect(await prepareTarget(local, "stopped", f.deps)).toEqual({ built: ALL });
  await f.lifecycle.up(local);
  // Both Services run: only the Tool still has work, and the shared unit precedes it.
  expect(await prepareTarget(local, "stopped", f.deps)).toEqual({
    built: ["shared", "tool:tool"],
  });
  f.running.delete("target:web");
  expect(await prepareTarget(local, "stopped", f.deps)).toEqual({
    built: ["shared", "service:web", "tool:tool"],
  });
  f.running.add("target:web");
  local.plan.components = local.plan.components.filter(
    (component) => component.kind !== "installed",
  );
  local.plan.builds = local.plan.builds!.filter(
    (unit) => unit.component !== "tool",
  );
  expect(await prepareTarget(local, "stopped", f.deps)).toEqual({ built: [] });
  expect(await prepareTarget(local, "all", f.deps)).toEqual({
    built: ["shared", "service:api", "service:web"],
  });
});

test("an env-file value never reaches a unit's recorded policy, while its declared command, budget, env and workspace do", async () => {
  const f = await fixture();
  const secrets = join(f.root, "secrets.env");
  await writeFile(secrets, "TOKEN=first\n", { mode: 0o600 });
  const plan = structuredClone(f.candidate.plan);
  plan.components[0] = {
    ...plan.components[0]!,
    envFiles: [{ path: secrets }],
  } as (typeof plan.components)[number];
  const api = plan.builds![1]!;
  const before = unitPolicy(api, plan);
  await writeFile(secrets, "TOKEN=rotated\n", { mode: 0o600 });
  expect(unitPolicy(api, plan)).toBe(before);
  expect(before).not.toContain("first");
  for (const changed of [
    unitPolicy({ ...api, command: "other" }, plan),
    unitPolicy({ ...api, timeout: 5 }, plan),
    unitPolicy(api, { ...plan, workspacePath: join(f.root, "old") }),
    unitPolicy(api, {
      ...plan,
      components: [
        { ...plan.components[0]!, env: { MODE: "fast" } },
        ...plan.components.slice(1),
      ],
    }),
  ])
    expect(changed).not.toBe(before);
});
