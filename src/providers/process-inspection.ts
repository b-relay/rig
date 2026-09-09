import { z } from "zod";
import { RigError } from "../domain/errors";
import type { CommandRunner } from "./contracts";
import { runCommand } from "./command-runner";
import {
  createProcessIdentityReader,
  type ProcessIdentityReader,
} from "./process-identity";

const groupRows = z
  .array(
    z.string().trim().regex(/^[1-9]\d*$/)
      .describe("A process ID returned by process-group inspection."),
  )
  .nonempty();

/** Process-mode ownership and group control; uncertainty rejects instead of proving absence. */
export interface ProcessInspection {
  readonly identity: ProcessIdentityReader;
  groupExists(pid: number): Promise<boolean>;
  signalGroup(pid: number, signal: NodeJS.Signals): Promise<void>;
}
export interface ProcessInspectionOptions {
  readonly run?: CommandRunner;
  readonly kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
}

/** Owns OS probes, permission fallback and signal error translation. */
export function createProcessInspection(
  options: ProcessInspectionOptions = {},
): ProcessInspection {
  const run = options.run ?? runCommand;
  const kill = options.kill ?? ((pid, signal) => {
    process.kill(pid, signal);
  });
  async function groupExists(pid: number): Promise<boolean> {
    try {
      kill(-pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      const result = await run({
        command: ["/bin/ps", "-g", String(pid), "-o", "pid="],
        timeoutMs: 2000,
      }).catch(() => undefined);
      if (result?.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim())
        return false;
      if (
        result?.exitCode === 0 && !result.stderr.trim() &&
        groupRows.safeParse(result.stdout.trim().split(/\r?\n/)).success
      ) return true;
      throw new RigError(
        "PROCESS_INSPECT",
        "Process group presence could not be verified.",
        "Check process inspection permissions before retrying.",
        { pid },
      );
    }
  }
  async function signalGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
    try {
      kill(-pid, signal);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ESRCH" ||
        ((error as NodeJS.ErrnoException).code === "EPERM" &&
          !(await groupExists(pid)))
      )
        return;
      throw new RigError(
        "PROCESS_SIGNAL",
        "The managed process could not be signalled.",
        "Check process ownership and retry.",
        { pid, signal },
      );
    }
  }
  return { identity: createProcessIdentityReader(run), groupExists, signalGroup };
}
