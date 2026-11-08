import { spawn } from "node:child_process";
import { join } from "node:path";
import { openPrivateFile } from "../providers/private-files";
import { RigError } from "../domain/errors";
import type { DaemonLauncher } from "./admin-launcher";

/** rigd as a detached process of `command`, run in `root` with its output appended to the daemon's startup log and stopped by
 * signal. `environment` is read as the process starts. Also how a system job's rigd is stopped: by its pid, after which
 * launchd starts the job's program again. */
export function createDaemonProcess(options: {
  root: string;
  command: readonly string[];
  environment: () => Record<string, string>;
}): DaemonLauncher {
  return {
    async start() {
      const [executable, ...args] = options.command;
      if (!executable)
        throw new RigError(
          "DAEMON_COMMAND",
          "No daemon executable is configured.",
          "Build rigd first.",
        );
      const log = await openPrivateFile(
        options.root,
        join(options.root, "daemon", "startup.log"),
        "append",
      );
      try {
        const child = spawn(executable, args, {
          cwd: options.root,
          env: options.environment(),
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        });
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
      } finally {
        await log.close();
      }
    },
    async stop(pid) {
      process.kill(pid, "SIGTERM");
    },
    async stopUnreachable(alive) {
      for (const { pid } of await alive())
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
    },
    async abandon() {},
    async discard() {},
  };
}
