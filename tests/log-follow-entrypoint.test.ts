import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startControlPlane } from "../src/daemon/server";
import { createRuntimeFiles } from "../src/adapters/runtime-files";
import type { TargetRecord } from "../src/domain/runtime";

test("compiled follow uses production scheduling and terminates on SIGTERM without continued reads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rig-compiled-follow-"));
  const root = join(directory, ".rig");
  const binary = join(directory, "rig");
  const target = { id: "stopped-fixture", name: "live", desired: "stopped", logRoot: join(root, "logs") } as TargetRecord;
  const requests: string[] = [];
  const files = createRuntimeFiles();
  let notifyPoll: () => void = () => {};
  const polled = new Promise<void>((resolve) => { notifyPoll = resolve; });
  const server = startControlPlane({
    port: 0, token: "isolated-follow-token", instanceId: "follow-fixture",
    async handle(request) {
      requests.push(request.action);
      if (requests.length === 2) notifyPoll();
      if (request.action !== "logs") throw new Error("Unexpected lifecycle request");
      return { project: "fixture", target: "live", ...await files.logs(target, request.after, 100) };
    },
  });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await mkdir(join(root, "daemon"), { recursive: true });
    await mkdir(join(root, "auth"));
    await mkdir(target.logRoot);
    await writeFile(join(root, "daemon/address.json"), JSON.stringify({ port: server.port, pid: process.pid, instanceId: "follow-fixture" }));
    await writeFile(join(root, "auth/control-plane.token"), "isolated-follow-token");
    await writeFile(join(target.logRoot, "target.jsonl"), JSON.stringify({ timestamp: "2026-09-09T12:00:00Z", component: "setup", stream: "stdout", line: "retained setup output" }) + "\n");
    const build = Bun.spawn([process.execPath, "build", "--compile", join(import.meta.dir, "../src/index.ts"), "--outfile", binary], { stdout: "pipe", stderr: "pipe", env: { ...process.env, RIG_ROOT: root } });
    const [buildCode, buildError] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    expect({ code: buildCode, error: buildCode ? buildError : "" }).toEqual({ code: 0, error: "" });
    const running = Bun.spawn([binary, "logs", "live", "--project", "fixture", "--follow"], { cwd: directory, env: { ...process.env, RIG_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    child = running;
    const output = new Response(running.stdout).text();
    const error = new Response(running.stderr).text();
    await Promise.race([polled, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("Compiled follow never polled")), 5000); })]);
    clearTimeout(watchdog);
    // Allow the empty page to be delivered so termination happens in the production wait.
    await Bun.sleep(30);
    const stoppedAt = performance.now();
    child.kill("SIGTERM");
    const exit = await Promise.race([child.exited, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("Compiled follow failed to terminate")), 1000); })]);
    clearTimeout(watchdog);
    expect(exit).toBe(0);
    expect(performance.now() - stoppedAt).toBeLessThan(250);
    expect((await output).match(/retained setup output/g)).toHaveLength(1);
    expect(await error).toBe("");
    const count = requests.length;
    await Bun.sleep(300);
    expect(requests.length).toBe(count);
    expect(requests).toEqual(["logs", "logs"]);
    expect(target.desired).toBe("stopped");
  } finally {
    clearTimeout(watchdog);
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
