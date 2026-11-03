import { createHash } from "node:crypto";
import { RigError } from "../domain/errors";
import type { CommandRunner } from "./contracts";
import { lstartText, type ProcessStartReader } from "./native-process-start";
export type ProcessIdentityReader = (
  pid: number,
) => Promise<string | undefined>;
/** A lease is usable only while the PID and immutable process birth time still match. The birth time comes from `start`
 * where the kernel can be asked directly, otherwise from `ps`; both make the same identity, so a lease written through
 * one is read through the other. */
export function createProcessIdentityReader(
  run: CommandRunner,
  start?: ProcessStartReader,
): ProcessIdentityReader {
  const uninspectable = (pid: number) =>
    new RigError(
      "PROCESS_INSPECT",
      "Process ownership could not be verified.",
      "Check process inspection permissions before retrying.",
      { pid },
    );
  const identityOf = (pid: number, lstart: string) =>
    createHash("sha256").update(`${pid}:${lstart}`).digest("hex");
  return async (pid) => {
    if (start) {
      let seconds: number | undefined;
      try {
        seconds = start(pid);
      } catch {
        throw uninspectable(pid);
      }
      return seconds === undefined
        ? undefined
        : identityOf(pid, lstartText(seconds, "utc"));
    }
    const result = await run({
      command: ["/bin/ps", "-p", String(pid), "-o", "lstart="],
      timeoutMs: 2000,
      env: { LC_ALL: "C", TZ: "UTC", PATH: "/usr/bin:/bin" },
    });
    if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim())
      return undefined;
    if (result.exitCode !== 0) throw uninspectable(pid);
    const identity = result.stdout.trim();
    return identity ? identityOf(pid, identity) : undefined;
  };
}
