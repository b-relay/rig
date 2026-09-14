import { expect, test } from "bun:test";
import { createTargetLifecycle, type TargetEffects } from "../src/runtime/lifecycle";
import type { TargetRecord } from "../src/domain/runtime";

function scheduleFixture() {
  let now = 0;
  const pending = new Set<{ at: number; fire: () => void }>();
  return {
    schedule(delayMs: number, fire: () => void) {
      const task = { at: now + delayMs, fire };
      pending.add(task);
      return () => { pending.delete(task); };
    },
    advance(ms: number) {
      now += ms;
      for (const task of [...pending].sort((a, b) => a.at - b.at)) {
        if (task.at <= now && pending.delete(task)) task.fire();
      }
    },
    get pending() { return pending.size; },
  };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
/** crashes: keys whose process exits with the given code as soon as it is started. */
function fixture(health: TargetEffects["health"], options: { healthChecks?: boolean; crashes?: Record<string, number> } = {}) {
  const root = process.env.RIG_ROOT!;
  const record: TargetRecord = {
    id: "readiness", projectId: "project", name: "local", kind: "local",
    desired: "running", createdAt: "now", updatedAt: "now", logRoot: `${root}/logs`,
    plan: {
      project: "demo", target: "local", workspacePath: `${root}/workspace`, dataRoot: `${root}/data`,
      deploymentName: "local", branchSlug: "local", subdomain: "local",
      providers: { processSupervisor: "child" }, providerProfile: "default", preparedComponents: [],
      hooks: { postStart: "target-post" },
      components: ["prior", "new"].map(name => ({ name, kind: "managed", command: "serve", port: 4000, readyTimeout: 1,
        env: {}, dependsOn: [], ...(options.healthChecks === false ? {} : { health: "http://127.0.0.1/health" }), hooks: { postStart: `${name}-post` } })),
    },
  };
  const running = new Set(["readiness:prior"]);
  const exitCodes = new Map<string, number>();
  const events: string[] = [];
  const checkpoint = { targetId: record.id, async commit() { events.push("commit"); }, async rollback() { events.push("rollback"); } };
  const effects: TargetEffects = {
    async checkpoint() { return checkpoint; }, async restoreEffects() {}, async commitEffects() {},
    async retireSuperseded() {}, async retireArtifacts() {}, async prepare() {}, async environment() { return {}; },
    async install() { return { outcome: "unchanged" }; }, async removeRoute() {},
    supervisor: () => ({
      async observe(key) {
        if (running.has(key)) return { state: "running" };
        const exitCode = exitCodes.get(key);
        return exitCode === undefined ? { state: "stopped" } : { state: "stopped", exitCode };
      },
      async ensureRunning(request) {
        events.push(`start:${request.key}`);
        const crash = options.crashes?.[request.key];
        if (crash === undefined) running.add(request.key);
        else exitCodes.set(request.key, crash);
        return { outcome: "started" };
      },
      async stop(key) { running.delete(key); events.push(`stop:${key}`); return { outcome: "stopped" }; }, async shutdown() {}, async detach() {},
    }),
    async hook(command) { events.push(command); }, async route() { events.push("route"); }, health,
  };
  const timing = scheduleFixture();
  return { record, running, exitCodes, events, checkpoint, timing, lifecycle: createTargetLifecycle(effects, timing) };
}

test("a process that has exited is reported with its exit code before the first health poll instead of after readyTimeout", async () => {
  let polls = 0;
  const f = fixture(async () => { polls++; return false; }, { crashes: { "readiness:new": 127 } });
  await expect(f.lifecycle.up(f.record)).rejects.toMatchObject({
    code: "PROCESS_EXITED",
    message: "new exited with code 127 before it became ready.",
    details: { component: "new", exitCode: 127 },
  });
  expect(polls).toBe(0);
  expect(f.events).toEqual(["start:readiness:new", "stop:readiness:new", "rollback"]);
  expect(f.timing.pending).toBe(0);
});

test("a passing health check does not certify a component whose own process has exited", async () => {
  const f = fixture(async () => {
    // A foreign listener answers on the port while rig's process dies.
    f.running.delete("readiness:new");
    f.exitCodes.set("readiness:new", 1);
    return true;
  });
  await expect(f.lifecycle.up(f.record)).rejects.toMatchObject({
    code: "PROCESS_EXITED",
    details: { component: "new", exitCode: 1 },
  });
  expect(f.events).toEqual(["start:readiness:new", "stop:readiness:new", "rollback"]);
  expect(f.timing.pending).toBe(0);
});

test("a component with no health check counts as started only after surviving the start grace period", async () => {
  const f = fixture(async () => true, { healthChecks: false });
  let settled = false;
  const result = f.lifecycle.up(f.record).then((outcome) => { settled = true; return outcome; });
  await flush();
  expect(settled).toBe(false);
  expect(f.events).toEqual(["start:readiness:new"]);
  f.timing.advance(500);
  expect(await result).toEqual({ outcome: "started" });
  expect(f.events).toEqual(["start:readiness:new", "new-post", "route", "target-post", "commit"]);
  expect(f.timing.pending).toBe(0);
});

test("a component with no health check that exits during the start grace period is a failed start", async () => {
  const f = fixture(async () => true, { healthChecks: false, crashes: { "readiness:new": 99 } });
  let failure: unknown;
  const result = f.lifecycle.up(f.record).catch((error) => { failure = error; });
  await flush();
  expect(failure).toBeUndefined();
  f.timing.advance(100);
  await result;
  expect(failure).toMatchObject({
    code: "PROCESS_EXITED",
    details: { component: "new", exitCode: 99 },
  });
  expect(f.events).toEqual(["start:readiness:new", "stop:readiness:new", "rollback"]);
  expect(f.timing.pending).toBe(0);
});

test("controlled deadline bounds uncooperative health and prevents late revival", async () => {
  let signal: AbortSignal | undefined;
  let finish!: (healthy: boolean) => void;
  const f = fixture((_component, _target, abort) => { signal = abort; return new Promise(resolve => { finish = resolve; }); });
  let failure: unknown;
  const result = f.lifecycle.up(f.record).catch(error => { failure = error; });
  await flush();
  expect(f.events).toEqual(["start:readiness:new"]);
  f.timing.advance(1000);
  await flush();
  expect(failure).toMatchObject({ code: "HEALTH_FAILED" });
  await result;
  expect(signal?.aborted).toBe(true);
  expect([...f.running]).toEqual(["readiness:prior"]);
  expect(f.events).toEqual(["start:readiness:new", "stop:readiness:new", "rollback"]);
  finish(true);
  await flush();
  expect(f.events).toEqual(["start:readiness:new", "stop:readiness:new", "rollback"]);
  expect(f.timing.pending).toBe(0);
});

test("immediate health permits post-start and route publication and cancels the deadline", async () => {
  const f = fixture(async () => true);
  expect(await f.lifecycle.up(f.record)).toEqual({ outcome: "started" });
  expect(f.events).toEqual(["start:readiness:new", "new-post", "route", "target-post", "commit"]);
  expect(f.timing.pending).toBe(0);
  f.timing.advance(1000);
  expect([...f.running]).toEqual(["readiness:prior", "readiness:new"]);
});

test("unhealthy readiness retries after 100ms, then proceeds promptly on success", async () => {
  let calls = 0;
  const f = fixture(async () => ++calls === 2);
  const result = f.lifecycle.up(f.record);
  await flush();
  f.timing.advance(99);
  await flush();
  expect(calls).toBe(1);
  expect(f.events).toEqual(["start:readiness:new"]);
  f.timing.advance(1);
  expect(await result).toEqual({ outcome: "started" });
  expect(calls).toBe(2);
  expect(f.timing.pending).toBe(0);
});

test.each([0.05, 0.1, 0.25])("unhealthy readiness expires at %ss even during a retry delay", async timeout => {
  let calls = 0;
  const f = fixture(async () => { calls++; return false; });
  const component = f.record.plan.components[1]!;
  if (component.kind !== "managed") throw new Error("Expected managed fixture");
  component.readyTimeout = timeout;
  let failure: unknown;
  const result = f.lifecycle.up(f.record).catch(error => { failure = error; });
  await flush();
  if (timeout === 0.25) {
    f.timing.advance(100); await flush();
    f.timing.advance(100); await flush();
  }
  f.timing.advance(timeout === 0.25 ? 50 : timeout * 1000);
  await flush();
  expect(failure).toMatchObject({ code: "HEALTH_FAILED" });
  await result;
  expect(calls).toBe(timeout === 0.25 ? 3 : 1);
  expect(f.timing.pending).toBe(0);
  expect(f.events).toEqual(["start:readiness:new", "stop:readiness:new", "rollback"]);
});

test("provider rejection retains the original failure and cancels scheduling", async () => {
  const failure = new Error("health transport broke");
  const f = fixture(async () => { throw failure; });
  await expect(f.lifecycle.up(f.record)).rejects.toBe(failure);
  expect(f.timing.pending).toBe(0);
  expect(f.events).toEqual(["start:readiness:new", "stop:readiness:new", "rollback"]);
});

test("a supplied checkpoint remains owned by the deploy caller after expiry", async () => {
  const f = fixture(() => new Promise(() => {}));
  const result = f.lifecycle.up(f.record, f.checkpoint).catch(error => error);
  await flush();
  f.timing.advance(1000);
  expect(await result).toMatchObject({ code: "HEALTH_FAILED" });
  expect(f.events).toEqual(["start:readiness:new", "stop:readiness:new"]);
  await f.checkpoint.rollback();
  expect(f.events.at(-1)).toBe("rollback");
});

test("foreign checkpoint identity fails before any Target effects or scheduling", async () => {
  const f = fixture(async () => true);
  await expect(f.lifecycle.up(f.record, { ...f.checkpoint, targetId: "other" })).rejects.toMatchObject({ code: "EFFECTS_SCOPE" });
  expect(f.events).toEqual([]);
  expect(f.timing.pending).toBe(0);
});

test("deadline wins health success delivered after expiry in the same turn", async () => {
  let finish!: (healthy: boolean) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const result = f.lifecycle.up(f.record).catch(error => error);
  await flush();
  f.timing.advance(1000);
  finish(true);
  expect(await result).toMatchObject({ code: "HEALTH_FAILED" });
  expect(f.events).toEqual(["start:readiness:new", "stop:readiness:new", "rollback"]);
});

test("provider rejection queued before deadline retains its failure meaning", async () => {
  let rejectHealth!: (reason: Error) => void;
  const failure = new Error("provider rejected before deadline");
  const f = fixture(() => new Promise((_resolve, reject) => { rejectHealth = reject; }));
  const result = f.lifecycle.up(f.record).catch(error => error);
  await flush();
  rejectHealth(failure);
  f.timing.advance(1000);
  expect(await result).toBe(failure);
  expect(f.timing.pending).toBe(0);
  expect(f.events).toEqual(["start:readiness:new", "stop:readiness:new", "rollback"]);
});
