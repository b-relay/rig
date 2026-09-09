import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLaunchdSupervisor } from "../src/providers/launchd-supervisor";
import { createProcessIdentityReader } from "../src/providers/process-identity";
import { observeTargets } from "../src/runtime/status";
import type { TargetRecord } from "../src/domain/runtime";
import type { ProcessObservation } from "../src/providers/contracts";

// Real wrapper/application processes; only the OS launchctl boundary is replaced.
test("launchd reports application backoff, recovery identity, and terminal failure through public status", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-launchd-observation-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let replayExitingWrapperSnapshot = false;
  const inspect = createProcessIdentityReader();
  const wrapper = join(root, "capture.ts");
  await writeFile(wrapper, `import {runCapturedProcess} from ${JSON.stringify(resolve("src/providers/captured-process.ts"))}; process.exitCode=await runCapturedProcess(process.argv[2]!);`);
  const supervisor = createLaunchdSupervisor({
    root, domain: "gui/99999", labelPrefix: "test.observation",
    captureCommand: [process.execPath, wrapper],
    inspect: async pid => {
      if (replayExitingWrapperSnapshot && pid === child?.pid) await child.exited;
      return inspect(pid);
    },
    run: async ({ command }) => {
      if (command[1] === "bootstrap") {
        child = Bun.spawn([process.execPath, wrapper, command[3]!.replace(/\.plist$/, ".json")], { stdout: "ignore", stderr: "pipe" });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command[1] === "bootout") {
        child?.kill("SIGTERM");
        await child?.exited;
        child = undefined;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (replayExitingWrapperSnapshot && child) return { exitCode: 0, stdout: `pid = ${child.pid}\n`, stderr: "" };
      return child
        ? { exitCode: 0, stdout: child.exitCode === null ? `pid = ${child.pid}\n` : `last exit code = ${child.exitCode}\n`, stderr: "" }
        : { exitCode: 113, stdout: "", stderr: "Could not find service" };
    },
  });
  const request = {
    key: "application/web", componentName: "web", cwd: root, env: {}, logRoot: root, keepAlive: true,
    command: [process.execPath, "-e", `setTimeout(()=>process.exit(9), 350)`],
  };
  const target = { id: "application", name: "live", kind: "live", desired: "running", plan: { components: [
    { name: "web", kind: "managed", port: 4444 },
    { name: "checked", kind: "managed", port: 4445, health: "http://localhost:4445" },
  ] } } as TargetRecord;
  const report = () => observeTargets([target], {
    process: (_target, _component, signal) => supervisor.observe(request.key, signal),
    health: async () => true, artifact: async () => "installed", persistent: async () => true,
  });
  const waitFor = async (predicate: (value: ProcessObservation) => boolean) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const value = await supervisor.observe(request.key);
      if (predicate(value)) return value;
      await Bun.sleep(10);
    }
    throw new Error("Expected process transition was not observed");
  };
  try {
    const started = await supervisor.ensureRunning(request);
    expect(started.pid).not.toBe(child!.pid);
    const firstPid = started.pid;
    const pending = await waitFor(value => value.restartPending === true);
    expect(pending).toMatchObject({ state: "stopped", exitCode: 9, restartPending: true });
    expect((await report())[0]!.components.map(component => component.state)).toEqual(["starting", "starting"]);
    const wrapperPid = child!.pid;
    const resumed = await supervisor.ensureRunning(request);
    expect(resumed.outcome).toBe("unchanged");
    expect(child!.pid).toBe(wrapperPid);
    const recovered = await waitFor(value => value.state === "running" && value.pid !== firstPid);
    expect(recovered.pid).not.toBe(child!.pid);
    expect((await report())[0]!.components.map(component => component.state)).toEqual(["running", "healthy"]);
    await waitFor(value => value.state === "stopped" && !value.restartPending && value.exitCode === 9);
    // Replay a launchctl PID snapshot taken just before the wrapper exits. Its
    // subsequent identity lookup must remain unknown, never trust dead ownership.
    replayExitingWrapperSnapshot = true;
    expect((await report())[0]!.components.map(component => component.state)).toEqual(["unknown", "unknown"]);
    replayExitingWrapperSnapshot = false;
    // A terminal child snapshot can precede the wrapper's own process exit.
    await child!.exited;
    expect((await report())[0]!.components.map(component => component.state)).toEqual(["failed", "failed"]);
  } finally {
    await supervisor.stop(request.key);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test("capture observations reject missing, stale, corrupt, or mismatched evidence conservatively", async () => {
  const { createHash } = await import("node:crypto");
  const root = await mkdtemp(join(tmpdir(), "rig-capture-evidence-"));
  const key = "application/web";
  const path = join(root, `test.observation.${createHash("sha256").update(key).digest("hex").slice(0, 24)}.json.observation.json`);
  const wrapperIdentity = "a".repeat(64);
  const applicationIdentity = "b".repeat(64);
  const evidence = {
    wrapperPid: 101, wrapperIdentity, observedAt: 10_000,
    applicationIdentity, observation: { state: "running", pid: 202 },
  };
  const supervisor = createLaunchdSupervisor({
    root, domain: "gui/99999", labelPrefix: "test.observation", captureCommand: ["capture"],
    now: () => 10_000,
    inspect: async pid => pid === 101 ? wrapperIdentity : pid === 202 ? applicationIdentity : undefined,
    run: async () => ({ exitCode: 0, stdout: "pid = 101\n", stderr: "" }),
  });
  try {
    expect((await supervisor.observe(key)).state).toBe("unknown");
    for (const invalid of [
      "not json",
      JSON.stringify({ state: "running", pid: 202 }), // Legacy startup-only metadata is insufficient.
      JSON.stringify({ ...evidence, observedAt: 8_999 }),
      JSON.stringify({ ...evidence, observedAt: 10_001 }),
      JSON.stringify({ ...evidence, wrapperPid: 999 }),
      JSON.stringify({ ...evidence, wrapperIdentity: "c".repeat(64) }),
      JSON.stringify({ ...evidence, applicationIdentity: "c".repeat(64) }),
      JSON.stringify({ ...evidence, applicationIdentity: undefined }),
      JSON.stringify({ ...evidence, observation: { state: "running", pid: 999 } }),
    ]) {
      await writeFile(path, invalid);
      expect((await supervisor.observe(key)).state).toBe("unknown");
    }
    await writeFile(path, JSON.stringify(evidence));
    expect(await supervisor.observe(key)).toEqual({ state: "running", pid: 202 });
    expect((await supervisor.observe(key, AbortSignal.abort())).state).toBe("unknown");
    for (const observation of [
      { state: "stopped", exitCode: 9, restartPending: true },
      { state: "stopped", exitCode: 9 },
      { state: "unknown", reason: "Child observation unavailable." },
    ] satisfies ProcessObservation[]) {
      await writeFile(path, JSON.stringify({ ...evidence, observation }));
      expect(await supervisor.observe(key)).toEqual(observation);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
