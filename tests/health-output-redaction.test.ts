import { afterEach, expect, test } from "bun:test";
import { wallClock } from "../src/domain/clock";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProjectConfig } from "../src/config";
import type {
  ProcessObservation,
  Supervisor,
} from "../src/providers/contracts";
import { createHealthMonitor } from "../src/runtime/health-monitor";
import { runtimeWorld } from "./support/runtime-world";

/** A failing health check that prints a value from the Service's env file, through the real runtime, Target effects, health
 * monitor and state file over a scripted supervisor: what status, Activity, the Target logs and a start error keep of its
 * output. The dashboard shows the same status and Activity replies. */

const SECRET = "tok-health-output-0123456789";
/** Printed before 1,048,566 blanks, its first 12 characters fall outside what the runner keeps: qwertyuiop is left. */
const FLOOD = "flood-token-qwertyuiop";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function world() {
  const scratch = await mkdtemp(join(tmpdir(), "rig-health-redaction-"));
  roots.push(scratch);
  const failing = join(scratch, "failing");
  const flooding = join(scratch, "flooding");
  const envFile = join(scratch, "web.env");
  await writeFile(envFile, `API_TOKEN=${SECRET}\nFLOOD=${FLOOD}\n`, {
    mode: 0o600,
  });
  const config = parseProjectConfig({
    name: "demo",
    services: {
      web: {
        command: "serve",
        env_file: envFile,
        healthcheck: {
          // Flooding prints the value and then more than the 1 MiB the runner keeps, so the cut falls inside the value.
          test: `if [ -f '${failing}' ]; then printf 'auth failed for %s\\n' "$API_TOKEN" >&2; exit 1; fi; if [ -f '${flooding}' ]; then printf '%s' "$FLOOD"; printf '%1048566s' ''; exit 1; fi`,
          interval: "5s",
          retries: 1,
          start_period: "1s",
          on_failure: "report",
        },
      },
    },
    targets: { working: true },
  });
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
        pid: 5000 + processes.size,
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
  const timers: { at: number; fire: () => void }[] = [];
  let monitor!: ReturnType<typeof createHealthMonitor>;
  const w = await runtimeWorld({
    name: "health-redaction",
    config,
    supervisor: () => supervisor,
    startsAt: "2026-10-20T08:00:00.000Z",
    readinessDeadlineMs: 300,
    lifecycleObserver: {
      changing: (target, service) => monitor?.invalidate(target.id, service),
      activated: (target, service, incarnation) =>
        monitor?.started(target, service, incarnation),
    },
    dependencies: () => ({
      healthResults: (target: { id: string }, service: string) =>
        monitor?.results(target, service),
    }),
  });
  roots.push(w.root);
  const runtime = w.open();
  monitor = createHealthMonitor({
    store: w.store,
    observations: w.deps.observations,
    clock: wallClock(() => w.clock.ms),
    id: () => `h${Math.random()}`,
    busy: runtime.targetBusy,
    restart: runtime.restartUnhealthy,
    schedule(delayMs, fire) {
      const timer = { at: w.clock.ms + delayMs, fire };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    async diagnostic() {},
    report: { failed() {}, succeeded() {} },
  });
  await runtime.command({ action: "init", repoPath: w.repo });
  return {
    runtime,
    root: w.root,
    fail: () => writeFile(failing, ""),
    flood: () => writeFile(flooding, ""),
    /** One second of fake time per step: rigd's supervision pass and the health monitor's pass, each settled. */
    async advance(seconds: number) {
      for (let i = 0; i < seconds; i++) {
        w.clock.ms += 1000;
        for (const timer of timers.filter((t) => t.at <= w.clock.ms)) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fire();
        }
        await runtime.supervise();
        await monitor.pass();
        await monitor.idle();
      }
    },
  };
}
/** Every file under `directory`, as text. */
async function everything(directory: string): Promise<string> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const texts = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
  );
  return texts.join("\n");
}

test("a failing health check that prints an env-file value shows it as [redacted] in status, Activity, the Target logs and a start error", async () => {
  const w = await world();
  await w.runtime.command({ action: "up", project: "demo", target: "working" });
  await w.fail();
  await w.advance(6);
  const output = "exit code 1: auth failed for [redacted]";
  const status = await w.runtime.command({ action: "status", project: "demo" });
  expect(JSON.stringify(status)).toContain(output);
  const activity = await w.runtime.command({
    action: "activity",
    project: "demo",
  });
  expect(JSON.stringify(activity)).toContain(
    `web is unhealthy: 1 health check in a row failed (${output}).`,
  );
  const restarted = await w.runtime
    .command({ action: "restart", project: "demo", target: "working" })
    .then(
      () => undefined,
      (error: Error) => error,
    );
  expect(restarted).toMatchObject({
    code: "HEALTH_FAILED",
    message: `web did not become ready (last check: ${output}).`,
  });
  expect(
    JSON.stringify(
      await w.runtime.command({ action: "activity", project: "demo" }),
    ),
  ).toContain(output);
  // Nothing Rig keeps holds the value: state, Activity, the Target logs.
  const kept = await everything(w.root);
  expect(kept).toContain("[redacted]");
  expect(kept).not.toContain(SECRET);
}, 20_000);

test("health output a rigd before redaction recorded in Activity is withheld from the Activity the dashboard reads", async () => {
  const w = await world();
  // State as the previous rigd left it: version 8, with a check's output as printed.
  const path = join(w.root, "runtime", "state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.version = 8;
  state.activity.push({
    id: "legacy",
    projectId: state.projects[0].id,
    project: "demo",
    target: "working",
    component: { kind: "service", name: "web" },
    action: "health",
    outcome: "failed",
    occurredAt: "2026-10-19T08:00:00.000Z",
    message: `web is unhealthy: 1 health check in a row failed (exit code 1: auth failed for ${SECRET}). Its healthcheck's on_failure is report, so Rig only reports it.`,
  });
  await writeFile(path, JSON.stringify(state));
  const activity = JSON.stringify(
    await w.runtime.command({ action: "activity", project: "demo" }),
  );
  expect(activity).not.toContain(SECRET);
  expect(activity).toContain(
    "web is unhealthy: 1 health check in a row failed (output withheld: recorded before Rig redacted health output).",
  );
});

test("a failing health check whose output passes what the runner keeps shows no part of a value cut at the boundary", async () => {
  const w = await world();
  await w.runtime.command({ action: "up", project: "demo", target: "working" });
  await w.flood();
  await w.advance(6);
  const status = JSON.stringify(
    await w.runtime.command({ action: "status", project: "demo" }),
  );
  expect(status).toContain('"output":"exit code 1"');
  const activity = JSON.stringify(
    await w.runtime.command({ action: "activity", project: "demo" }),
  );
  expect(activity).toContain("1 health check in a row failed (exit code 1).");
  expect(await everything(w.root)).not.toContain("qwertyuiop");
}, 20_000);
