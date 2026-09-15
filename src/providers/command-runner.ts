import { spawn } from "node:child_process";
import { RigError } from "../domain/errors";
import type { CommandRunner } from "./contracts";
/** Runs a bounded command and captures at most 1 MiB per stream. A command past its budget has its
 * whole process group killed and resolves with what it printed, marked timedOut; one cancelled through
 * the signal rejects with COMMAND_CANCELLED. */
export const runCommand: CommandRunner = async ({
  command,
  cwd,
  env,
  signal,
  timeoutMs = 120_000,
  onOutput,
}) => {
  if (!command.length)
    throw new RigError(
      "COMMAND_EMPTY",
      "A provider command is empty.",
      "Configure an executable command.",
    );
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0]!, [...command.slice(1)], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      ended: "timed-out" | "cancelled" | undefined;
    const kill = (reason: "timed-out" | "cancelled") => {
      ended ??= reason;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };
    const cancel = () => kill("cancelled");
    const timer = setTimeout(() => kill("timed-out"), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout = (stdout + chunk).slice(-1_048_576);
      onOutput?.("stdout", chunk);
    });
    child.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr = (stderr + chunk).slice(-1_048_576);
      onOutput?.("stderr", chunk);
    });
    child.on("error", (error) => {
      cleanup();
      reject(
        new RigError(
          "COMMAND_START",
          `Provider command '${command[0]}' could not start (${error.message}).`,
          "Check that the executable exists and is on the PATH, and that the working directory exists.",
          { executable: command[0], cause: error.message },
        ),
      );
    });
    child.on("close", (code) => {
      cleanup();
      if (ended === "cancelled")
        reject(
          new RigError(
            "COMMAND_CANCELLED",
            "A provider command was cancelled before it finished.",
            "Retry the operation.",
            { command: command[0] },
          ),
        );
      else if (ended === "timed-out")
        resolve({ exitCode: 1, stdout, stderr, timedOut: true });
      else resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
};
