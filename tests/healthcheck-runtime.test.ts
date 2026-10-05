import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config";
import type { ProjectConfig } from "../src/config/types";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { runtimeWorld } from "./support/runtime-world";

/** ADR 0012 in the runtime: plans recorded before healthcheck keep their meaning, and status reads cached results. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** A working Target of one Project whose rig.yaml is `config`, read live, over a supervisor that starts every process. */
async function fixture(services: Record<string, unknown>) {
  const config = parseProjectConfig({ name: "demo", services });
  const processes = new Map<string, ProcessObservation>();
  const supervisor: Supervisor = {
    async observe(key) {
      return processes.get(key) ?? { state: "stopped" };
    },
    async ensureRunning(request) {
      if (processes.get(request.key)?.state === "running")
        return { outcome: "unchanged" };
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
    name: "healthcheck",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-05T08:00:00.000Z",
    readinessDeadlineMs: 2000,
  });
  roots.push(world.root);
  const runtime = world.open();
  await runtime.command({ action: "init", repoPath: world.repo });
  const statePath = join(world.root, "runtime", "state.json");
  return {
    ...world,
    config: config as ProjectConfig & Record<string, unknown>,
    runtime,
    /** The working Target's config check, as doctor reports it. */
    async configCheck() {
      const report = (await runtime.command({
        action: "doctor",
        project: "demo",
      })) as { checks: { name: string; ok: boolean; reason?: string }[] };
      return report.checks.find((check) => check.name === "working/config");
    },
    /** Rewrites the recorded state file as an older rigd would have left it. */
    async rewriteState(change: (state: Record<string, any>) => void) {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      change(state);
      await writeFile(statePath, JSON.stringify(state));
    },
    async savedState(): Promise<string> {
      return readFile(statePath, "utf8");
    },
  };
}

test("a Service without a healthcheck plans what a rigd before healthcheck recorded, so its running Target shows no drift", async () => {
  const f = await fixture({ web: { command: "serve" } });
  await f.runtime.command({ action: "up", project: "demo", target: "working" });
  const web = (await f.store.read()).targets[0]!.plan.components[0]!;
  // The shape a rigd before healthcheck recorded for a Service without ready: a 30 s start budget and nothing more.
  expect(web).toMatchObject({ name: "web", readyTimeout: 30 });
  expect(web).not.toHaveProperty("health");
  expect(web).not.toHaveProperty("healthcheck");
  expect(await f.configCheck()).toMatchObject({ ok: true });
});

test("a plan recorded from ready keeps meaning a start check only: it loads, is checked by status as before, and moving ready to healthcheck is drift", async () => {
  const f = await fixture({
    web: {
      command: "serve",
      healthcheck: { test: "true", start_period: "1m" },
    },
  });
  await f.runtime.command({ action: "up", project: "demo", target: "working" });
  // What a rigd before healthcheck recorded for `ready: "true"` and `ready_timeout: 1m`: the same start check, no
  // ongoing checks.
  await f.rewriteState((state) => {
    delete state.targets[0].plan.components[0].healthcheck;
  });
  const reopened = f.open();
  const recorded = (await f.store.read()).targets[0]!.plan.components[0]!;
  expect(recorded).toMatchObject({ health: "true", readyTimeout: 60 });
  expect(recorded).not.toHaveProperty("healthcheck");
  // No monitor result is read for it: status runs its check, as before healthcheck.
  const status = await reopened.status({
    project: "demo",
    target: "working",
  });
  expect(status.targets[0]!.components[0]).toMatchObject({ state: "healthy" });
  expect(status.targets[0]!.components[0]).not.toHaveProperty("health");
  // rig.yaml now says healthcheck, which also means ongoing checks: true drift, until the Target is planned again.
  expect(await f.configCheck()).toMatchObject({
    ok: false,
    reason: "config-drift",
  });
  await reopened.command({
    action: "restart",
    project: "demo",
    target: "working",
  });
  expect((await f.store.read()).targets[0]!.plan.components[0]).toMatchObject({
    healthcheck: { interval: 30, timeout: 30, retries: 3, onFailure: "report" },
  });
  expect(await f.configCheck()).toMatchObject({ ok: true });
});

test("state written with a healthcheck and an unhealthy stretch is read back as written; only #317's retired fields are dropped", async () => {
  const f = await fixture({
    web: { command: "serve", healthcheck: { test: "true" } },
  });
  await f.runtime.command({ action: "up", project: "demo", target: "working" });
  await f.rewriteState((state) => {
    const target = state.targets[0];
    target.services.web.healthStretch = { since: 1, restarts: [2] };
    target.plan.components[0].healthMonitor = {
      interval: 30,
      timeout: 5,
      failures: 3,
      onFailure: "restart",
    };
  });
  const read = (await f.store.read()).targets[0]!;
  expect(read.plan.components[0]).toMatchObject({
    healthcheck: { interval: 30, retries: 3 },
  });
  expect(read.plan.components[0]).not.toHaveProperty("healthMonitor");
  expect(read.services!.web!.healthStretch).toEqual({
    since: 1,
    restarts: [2],
  });
  // The next write saves it so.
  await f.store.update(() => {});
  const saved = await f.savedState();
  expect(saved).toContain("healthStretch");
  expect(saved).not.toContain("healthMonitor");
});

test("status and doctor read a Service's cached health and run no check for it", async () => {
  const checks: string[] = [];
  const f = await fixture({
    web: { command: "serve", healthcheck: { test: "true" } },
  });
  await f.runtime.command({ action: "up", project: "demo", target: "working" });
  const observations = f.deps.observations;
  f.deps.observations = {
    ...observations,
    async health(target, component, signal) {
      checks.push(component.name);
      return observations.health(target, component, signal);
    },
  };
  f.deps.healthResults = () => ({
    status: "unhealthy",
    checkedAt: "2026-10-05T07:59:48.000Z",
    failures: 3,
    retries: 3,
    output: "exit code 1: heartbeat 93s old",
    restarts: 0,
  });
  const runtime = f.open();
  const status = await runtime.status({ project: "demo", target: "working" });
  expect(status.targets[0]!.components[0]).toMatchObject({
    state: "unhealthy",
    health: { status: "unhealthy", failures: 3 },
    reason:
      "3 health checks in a row failed (exit code 1: heartbeat 93s old). Its healthcheck's on_failure is report, so Rig reports it and does not restart it.",
  });
  const doctor = (await runtime.command({
    action: "doctor",
    project: "demo",
  })) as { checks: { name: string; ok: boolean; hint?: string }[] };
  expect(
    doctor.checks.find((check) => check.name === "working/web"),
  ).toMatchObject({
    ok: false,
    hint: "Its health check failed; inspect the Target logs (rig logs working) and the Service's healthcheck in rig.yaml.",
  });
  expect(checks).toEqual([]);
});
