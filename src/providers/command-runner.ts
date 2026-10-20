import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { RigError } from "../domain/errors";
import type { CommandRunner } from "./contracts";
import { gatedCommand, releaseGate } from "./start-gate";
/** Runs a bounded command and captures the last 1 MiB of each stream, marking a stream it cut as truncated. A command past its budget has its
 * whole process group killed and resolves with what it printed, marked timedOut; one cancelled through
 * the signal rejects with COMMAND_CANCELLED. With `started`, the command runs behind a start gate released only once
 * `started` has recorded its group. */
/** How much of each stream the runner keeps, in characters. */
const OUTPUT_LIMIT = 1_048_576;
export const runCommand: CommandRunner = async ({
  command,
  cwd,
  env,
  signal,
  timeoutMs = 120_000,
  onOutput,
  started,
}) => {
  if (!command.length)
    throw new RigError(
      "COMMAND_EMPTY",
      "A provider command is empty.",
      "Configure an executable command.",
    );
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const spawned = started ? gatedCommand(command) : command;
    const child = spawn(spawned[0]!, [...spawned.slice(1)], {
      cwd,
      env,
      detached: true,
      stdio: [started ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      ended: "timed-out" | "cancelled" | "unrecorded" | undefined,
      unrecorded: unknown;
    const truncated: { stdout?: true; stderr?: true } = {};
    const kept = (stream: "stdout" | "stderr", text: string) => {
      if (text.length <= OUTPUT_LIMIT) return text;
      truncated[stream] = true;
      // Never starts at the second half of a surrogate pair.
      const start = text.length - OUTPUT_LIMIT;
      return text.slice(isLowSurrogate(text, start) ? start + 1 : start);
    };
    const kill = (reason: "timed-out" | "cancelled" | "unrecorded") => {
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
    // Nothing of the command runs until its group is recorded; a group that cannot be is killed at the gate.
    if (started)
      child.once("spawn", () => {
        started(child.pid!)
          .then(() => releaseGate(child.stdin!))
          .catch((error: unknown) => {
            unrecorded = error;
            kill("unrecorded");
            child.stdin?.destroy();
          });
      });
    // Each stream has its own decoder, so a character split between two chunks reaches the result and onOutput whole.
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const receive = (stream: "stdout" | "stderr", chunk: string) => {
      if (!chunk) return;
      if (stream === "stdout") stdout = kept("stdout", stdout + chunk);
      else stderr = kept("stderr", stderr + chunk);
      onOutput?.(stream, chunk);
    };
    child.stdout!.on("data", (data: Buffer) =>
      receive("stdout", decoders.stdout.write(data)),
    );
    child.stderr!.on("data", (data: Buffer) =>
      receive("stderr", decoders.stderr.write(data)),
    );
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
      // Bytes of a character the stream ended in the middle of.
      receive("stdout", decoders.stdout.end());
      receive("stderr", decoders.stderr.end());
      const cut = Object.keys(truncated).length ? { truncated } : {};
      if (ended === "unrecorded") reject(unrecorded);
      else if (ended === "cancelled")
        reject(
          new RigError(
            "COMMAND_CANCELLED",
            "A provider command was cancelled before it finished.",
            "Retry the operation.",
            { command: command[0] },
          ),
        );
      else if (ended === "timed-out")
        resolve({ exitCode: 1, stdout, stderr, timedOut: true, ...cut });
      else resolve({ exitCode: code ?? 1, stdout, stderr, ...cut });
    });
  });
};
function isLowSurrogate(text: string, at: number): boolean {
  const unit = text.charCodeAt(at);
  return unit >= 0xdc00 && unit <= 0xdfff;
}
