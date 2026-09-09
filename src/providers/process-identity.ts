import { createHash } from "node:crypto";
import { RigError } from "../domain/errors";
import type { CommandRunner } from "./contracts";
import { runCommand } from "./command-runner";
export type ProcessIdentityReader = (
  pid: number,
) => Promise<string | undefined>;
/** A lease is usable only while the PID and immutable process birth time still match. */
export function createProcessIdentityReader(
  run: CommandRunner = runCommand,
): ProcessIdentityReader {
  return async (pid) => {
    const result = await run({
      command: ["/bin/ps", "-p", String(pid), "-o", "lstart="],
      timeoutMs: 2000,
      env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
    });
    if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim())
      return undefined;
    if (result.exitCode !== 0)
      throw new RigError(
        "PROCESS_INSPECT",
        "Process ownership could not be verified.",
        "Check process inspection permissions before retrying.",
        { pid },
      );
    const identity = result.stdout.trim();
    return identity
      ? createHash("sha256").update(`${pid}:${identity}`).digest("hex")
      : undefined;
  };
}
