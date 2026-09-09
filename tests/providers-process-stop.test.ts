import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChildSupervisor } from "../src/providers/child-supervisor";
import { createProcessInspection } from "../src/providers/process-inspection";
import type { CommandRequest, CommandResult } from "../src/providers/contracts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const pid = 424242;
const birth = "Wed Sep  9 12:00:00 2026";
const errno = (code: string) => Object.assign(new Error(code), { code });
async function fixture(options: {
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  fallback: () => Promise<CommandResult>;
  identity?: () => string | undefined;
}) {
  const root = await mkdtemp(join(tmpdir(), "rig-stop-"));
  roots.push(root);
  const stateRoot = join(root, ".rig");
  const lease = join(stateRoot, "process-leases", createHash("sha256").update("owned").digest("hex") + ".json");
  await mkdir(join(stateRoot, "process-leases"), { recursive: true });
  await writeFile(lease, JSON.stringify({ key: "owned", pid, identity: createHash("sha256").update(`${pid}:${birth}`).digest("hex") }));
  const commands: CommandRequest[] = [];
  const supervisor = createChildSupervisor({
    stateRoot,
    stopTimeoutMs: 0,
    processInspection: createProcessInspection({
      kill: options.kill,
      run: async request => {
        commands.push(request);
        return request.command.includes("lstart=")
          ? { exitCode: 0, stdout: options.identity ? (options.identity() ?? "") : birth, stderr: "" }
          : options.fallback();
      },
    }),
  });
  return { supervisor, lease, commands };
}

test("stop accepts permission-denied signals and probes only when fallback confirms absence", async () => {
  const signals: Array<NodeJS.Signals | 0> = [];
  let fallbacks = 0;
  const { supervisor, lease, commands } = await fixture({
    kill: (target, signal) => { expect(target).toBe(-pid); signals.push(signal); throw errno("EPERM"); },
    fallback: async () => { fallbacks++; return { exitCode: 1, stdout: "", stderr: "" }; },
  });
  expect(await supervisor.stop("owned")).toEqual({ outcome: "stopped" });
  expect(signals).toContain("SIGTERM");
  expect(signals).not.toContain("SIGKILL");
  expect(fallbacks).toBeGreaterThan(0);
  expect(commands.filter(request => request.command.includes("pid="))).toContainEqual({
    command: ["/bin/ps", "-g", "424242", "-o", "pid="], timeoutMs: 2000,
  });
  expect(commands[0]).toEqual({
    command: ["/bin/ps", "-p", "424242", "-o", "lstart="], timeoutMs: 2000,
    env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
  });
  await expect(readFile(lease)).rejects.toMatchObject({ code: "ENOENT" });
});

test("stop rejects malformed permission fallback and preserves the lease", async () => {
  const { supervisor, lease } = await fixture({
    kill: () => { throw errno("EPERM"); },
    fallback: async () => ({ exitCode: 0, stdout: "424242 unexpected\n", stderr: "" }),
  });
  await expect(supervisor.stop("owned")).rejects.toMatchObject({ code: "PROCESS_INSPECT" });
  expect(JSON.parse(await readFile(lease, "utf8")).pid).toBe(pid);
});

test("failed escalation never reports a still-present owned group as stopped", async () => {
  const signals: Array<NodeJS.Signals | 0> = [];
  const { supervisor, lease } = await fixture({
    kill: (_target, signal) => { signals.push(signal); if (signal === 0) throw errno("EPERM"); },
    fallback: async () => ({ exitCode: 0, stdout: " 424242\n 424243\n", stderr: "" }),
  });
  await expect(supervisor.stop("owned")).rejects.toMatchObject({ code: "STOP_TIMEOUT" });
  expect(signals.filter(signal => signal !== 0)).toEqual(["SIGTERM", "SIGKILL"]);
  expect((await supervisor.observe("owned")).state).toBe("running");
  expect(JSON.parse(await readFile(lease, "utf8")).pid).toBe(pid);
});

for (const [name, fallback] of [
  ["empty success", async () => ({ exitCode: 0, stdout: "", stderr: "" })],
  ["mixed valid and malformed rows", async () => ({ exitCode: 0, stdout: "424242\nunknown\n", stderr: "" })],
  ["diagnostic on absence", async () => ({ exitCode: 1, stdout: "", stderr: "denied" })],
  ["diagnostic on presence", async () => ({ exitCode: 0, stdout: "424242\n", stderr: "partial result" })],
  ["command failure", async () => ({ exitCode: 2, stdout: "", stderr: "failed" })],
  ["command rejection", async () => { throw new Error("command timed out"); }],
] as const) {
  test(`stop preserves uncertainty for ${name}`, async () => {
    const { supervisor, lease } = await fixture({
      kill: () => { throw errno("EPERM"); }, fallback,
    });
    await expect(supervisor.stop("owned")).rejects.toMatchObject({ code: "PROCESS_INSPECT" });
    expect((await supervisor.observe("owned")).state).toBe("running");
    expect(JSON.parse(await readFile(lease, "utf8")).pid).toBe(pid);
  });
}

test("permission-denied delivery to a confirmed present group is a signal failure", async () => {
  const { supervisor, lease } = await fixture({
    kill: () => { throw errno("EPERM"); },
    fallback: async () => ({ exitCode: 0, stdout: "424242\n", stderr: "" }),
  });
  await expect(supervisor.stop("owned")).rejects.toMatchObject({ code: "PROCESS_SIGNAL" });
  expect((await supervisor.observe("owned")).state).toBe("running");
  expect(JSON.parse(await readFile(lease, "utf8")).pid).toBe(pid);
});

test("a successful probe followed by permission fallback presence escalates until confirmed absent", async () => {
  let gone = false;
  let probes = 0;
  let fallbackCalls = 0;
  const signals: Array<NodeJS.Signals | 0> = [];
  const { supervisor, lease } = await fixture({
    kill: (_target, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") gone = true;
      if (signal === 0 && ++probes > 1) throw errno("EPERM");
    },
    fallback: async () => {
      fallbackCalls++;
      return gone ? { exitCode: 1, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: "424242\n", stderr: "" };
    },
    identity: () => gone ? undefined : birth,
  });
  expect(await supervisor.stop("owned")).toEqual({ outcome: "stopped" });
  expect(signals.filter(signal => signal !== 0)).toEqual(["SIGTERM", "SIGKILL"]);
  expect(fallbackCalls).toBeGreaterThan(0);
  expect(await supervisor.stop("owned")).toEqual({ outcome: "unchanged" });
  expect(signals.filter(signal => signal !== 0)).toEqual(["SIGTERM", "SIGKILL"]);
  await expect(readFile(lease)).rejects.toMatchObject({ code: "ENOENT" });
});

test("ESRCH confirms absence without a fallback command", async () => {
  const { supervisor } = await fixture({
    kill: () => { throw errno("ESRCH"); },
    fallback: async () => { throw new Error("fallback must not run"); },
  });
  expect(await supervisor.stop("owned")).toEqual({ outcome: "stopped" });
});

for (const changeAt of [1, 3]) {
  test(`identity mismatch at read ${changeAt} never signals a recovered PID`, async () => {
    let identities = 0;
    let signals = 0;
    const { supervisor } = await fixture({
      identity: () => ++identities >= changeAt ? "a different birth time" : birth,
      kill: () => { signals++; },
      fallback: async () => { throw new Error("fallback must not run"); },
    });
    await supervisor.stop("owned");
    expect(signals).toBe(0);
    expect(identities).toBe(changeAt);
  });
}
