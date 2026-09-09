import { spawn } from "node:child_process";
import { RigError } from "../domain/errors";
import type { CommandRunner } from "./contracts";
/** Runs a bounded command, cancels its whole process group, and captures at most 1 MiB per stream. */
export const runCommand: CommandRunner = async ({
  command,
  cwd,
  env,
  signal,
  timeoutMs = 120_000,
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
      cancelled = false;
    const abort = () => {
      cancelled = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      }
    };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.stdout.on("data", (data) => {
      stdout = (stdout + data.toString()).slice(-1_048_576);
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data.toString()).slice(-1_048_576);
    });
    child.on("error", (error) => {
      cleanup();
      reject(
        new RigError(
          "COMMAND_START",
          "A provider command could not start.",
          "Check the executable and working directory.",
          { cause: error.message },
        ),
      );
    });
    child.on("close", (code) => {
      cleanup();
      if (cancelled)
        reject(
          new RigError(
            "COMMAND_TIMEOUT",
            "A provider command was cancelled or timed out.",
            "Check the command and retry.",
          ),
        );
      else resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
};
