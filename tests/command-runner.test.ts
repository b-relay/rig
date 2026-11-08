import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "../src/providers/command-runner";
import { processExists } from "../src/daemon/process-identity";

const env = { PATH: process.env.PATH! };

test("a command past its budget is killed and resolves with what it printed, marked timed out", async () => {
  const started = performance.now();
  const result = await runCommand({
    command: ["/bin/sh", "-c", "echo partial; echo warned >&2; sleep 30"],
    env,
    timeoutMs: 300,
  });
  expect(performance.now() - started).toBeLessThan(5000);
  expect(result).toEqual({
    exitCode: 1,
    stdout: "partial\n",
    stderr: "warned\n",
    timedOut: true,
  });
});

test("a command that finishes in time carries no timeout mark", async () => {
  expect(
    await runCommand({ command: ["/bin/sh", "-c", "exit 3"], env }),
  ).toEqual({ exitCode: 3, stdout: "", stderr: "" });
});

test("a cancelled command is distinguished from one that timed out", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await expect(
    runCommand({
      command: ["/bin/sh", "-c", "sleep 30"],
      env,
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: "COMMAND_CANCELLED" });
});

test("a command whose executable cannot start names the executable and the cause", async () => {
  const executable = "/nonexistent/rig-missing-executable";
  await expect(
    runCommand({ command: [executable], env }),
  ).rejects.toMatchObject({
    code: "COMMAND_START",
    message: expect.stringMatching(
      new RegExp(
        `^Provider command '${executable}' could not start \\(.*ENOENT.*\\)\\.$`,
      ),
    ),
    hint: "Check that the executable exists and is on the PATH, and that the working directory exists.",
    details: { executable, cause: expect.stringContaining("ENOENT") },
  });
});

test("output reaches onOutput as it is produced, while the command still runs", async () => {
  // Prints to both streams, then waits, alive, until the test tells it to finish.
  const script = `
process.on("SIGUSR1", () => process.stdout.write("second\\n", () => process.exit(0)));
process.stdout.write("first\\n");
process.stderr.write("warned\\n");
setInterval(() => {}, 60_000);`;
  let pid = 0;
  const seen: string[] = [];
  const both = {
    stdout: Promise.withResolvers<void>(),
    stderr: Promise.withResolvers<void>(),
  };
  const running = runCommand({
    command: [process.execPath, "-e", script],
    env,
    // Bounds the test should output be held back until the command ends: it never ends unless told to.
    timeoutMs: 4000,
    started: async (group) => void (pid = group),
    onOutput: (stream, chunk) => {
      seen.push(
        `${stream}:${chunk}${processExists(pid) ? "" : " after the command ended"}`,
      );
      both[stream].resolve();
    },
  });
  try {
    expect(
      await Promise.race([
        Promise.all([both.stdout.promise, both.stderr.promise]).then(
          () => "output",
        ),
        running.then(() => "ended"),
      ]),
    ).toBe("output");
    expect(seen.sort()).toEqual(["stderr:warned\n", "stdout:first\n"]);
  } finally {
    if (pid && processExists(pid)) process.kill(pid, "SIGUSR1");
  }
  expect(await running).toEqual({
    exitCode: 0,
    stdout: "first\nsecond\n",
    stderr: "warned\n",
  });
  expect(seen).toContain("stdout:second\n");
});

test("with started, the command runs only once its group was recorded, and never when the record fails", async () => {
  const order: string[] = [];
  const result = await runCommand({
    command: ["/bin/sh", "-c", 'echo "ran in $$"'],
    env,
    async started(pid) {
      order.push(`recorded ${pid}`);
      // Held a moment: the command must still be waiting at its gate.
      await Bun.sleep(50);
      order.push("released");
    },
  });
  expect(order).toEqual([expect.stringMatching(/^recorded \d+$/), "released"]);
  // The command runs as the recorded group's leader: the pid it was told is the one recorded.
  expect(result).toEqual({
    exitCode: 0,
    stdout: `ran in ${order[0]!.slice("recorded ".length)}\n`,
    stderr: "",
  });

  const unrecorded = new Error("the record could not be written");
  const marker = join(await mkdtemp(join(tmpdir(), "rig-runner-gate-")), "ran");
  await expect(
    runCommand({
      command: ["/bin/sh", "-c", `touch '${marker}'`],
      env,
      started: async () => {
        throw unrecorded;
      },
    }),
  ).rejects.toBe(unrecorded);
  expect(await Bun.file(marker).exists()).toBe(false);
  await rm(dirname(marker), { recursive: true });
});
