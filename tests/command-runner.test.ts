import { expect, test } from "bun:test";
import { runCommand } from "../src/providers/command-runner";

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

test("output reaches onOutput as it is produced, before the command ends", async () => {
  const seen: string[] = [];
  const result = await runCommand({
    command: [
      "/bin/sh",
      "-c",
      "echo first; echo warned >&2; sleep 0.2; echo second",
    ],
    env,
    onOutput: (stream, chunk) => seen.push(`${stream}:${chunk}`),
  });
  expect(result).toEqual({
    exitCode: 0,
    stdout: "first\nsecond\n",
    stderr: "warned\n",
  });
  expect(seen.sort()).toEqual([
    "stderr:warned\n",
    "stdout:first\n",
    "stdout:second\n",
  ]);
});
