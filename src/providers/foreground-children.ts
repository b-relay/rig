import { spawn } from "node:child_process";
import type { ChildProcesses, ChildExit } from "../helpers/convex-contracts";

/** Children of a process that runs as a Service: not detached, so they stay in the Service's process group (a stop or
 * kill of the group reaches them, and the listener check sees their sockets), with no stdin and this process's stdout
 * and stderr, which the capture wrapper records in the Target log. */
export function createForegroundChildren(): ChildProcesses {
  return {
    start({ command, cwd, env }) {
      const child = spawn(command[0]!, command.slice(1), {
        cwd,
        env,
        stdio: ["ignore", "inherit", "inherit"],
      });
      let ended = false;
      const exited = new Promise<ChildExit>((resolve) => {
        child.on("error", (error) => {
          // A child that started and then failed to be signalled also emits error; only a failed start ends it here.
          if (child.pid !== undefined) return;
          ended = true;
          resolve({ startError: error.message });
        });
        child.once("exit", (code, signal) => {
          ended = true;
          resolve(signal ? { signal } : { code: code ?? 1 });
        });
      });
      const signal = (name: NodeJS.Signals) => {
        if (ended) return;
        try {
          child.kill(name);
        } catch {
          /* It ended between the check and the signal. */
        }
      };
      return {
        exited,
        stop: () => signal("SIGTERM"),
        kill: () => signal("SIGKILL"),
      };
    },
  };
}
