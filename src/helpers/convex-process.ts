import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import type { ConvexCommandOptions } from "./convex-contracts";
import type { UserOutput } from "../cli/types";
import { runCommand } from "../providers/command-runner";
import { createConvexReleases } from "../providers/convex-releases";
import { createDeploymentFiles } from "../providers/deployment-files";
import { createForegroundChildren } from "../providers/foreground-children";
import { probeText } from "../providers/http-probe";
import { runConvexDeployment } from "./convex-local";

/** Signals that ask a Service to stop. The supervisor sends SIGTERM to the Service's process group, so the children get
 * it too; the helper still passes it on and waits for both. */
const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
/** Composition root of `rigd convex`: the one place that reads this process's working directory, environment, home,
 * platform and signals, and chooses the concrete providers. */
export async function runConvexProcess(
  options: ConvexCommandOptions,
  output: UserOutput,
): Promise<number> {
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  try {
    return await runConvexDeployment(
      {
        cloudPort: options.cloudPort,
        sitePort: options.sitePort,
        stateDir: options.stateDir,
        workspace: process.cwd(),
        instanceName: options.instanceName,
        ...(options.backendVersion === undefined
          ? {}
          : { pinnedRelease: options.backendVersion }),
        devArguments: options.devArguments,
        environment: process.env,
      },
      {
        releases: createConvexReleases({
          home: homedir(),
          platform: process.platform,
          arch: process.arch,
          run: runCommand,
          PATH: process.env.PATH,
          fetch,
        }),
        children: createForegroundChildren(),
        files: createDeploymentFiles(),
        run: runCommand,
        probe: probeText,
        wait: (ms, signal) =>
          new Promise((resolve) => {
            if (signal.aborted) return resolve();
            const timer = setTimeout(done, ms);
            function done() {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            }
            signal.addEventListener("abort", done, { once: true });
          }),
        now: Date.now,
        newInstanceSecret: () => randomBytes(32).toString("hex"),
        output,
      },
      stop.signal,
    );
  } finally {
    for (const signal of STOP_SIGNALS) process.removeListener(signal, onSignal);
  }
}
