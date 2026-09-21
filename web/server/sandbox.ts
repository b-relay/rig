import { RigError } from "../../src/domain/errors";

/** Runs `rigd <command>` against the sandbox's Rig root and answers with its exit code and what it printed. */
export type RunRigd = (
  command: "install" | "uninstall",
) => Promise<{ exitCode: number; output: string }>;

/** A throwaway rigd that belongs to one copy of the site, so a Preview's dashboard has a daemon to
 * drive without reaching the Host's. rigd runs as a plain process (a Rig root other than ~/.rig is
 * never loaded into launchd) and keeps all state, its token, and its Caddyfile under `root`. */
export function sandboxDaemon(root: string, run: RunRigd) {
  return {
    /** Installs and verifies the daemon; a daemon already serving `root` is left as it is. */
    async start(): Promise<void> {
      const { exitCode, output } = await run("install");
      if (exitCode !== 0)
        throw new RigError(
          "WEB_SANDBOX_FAILED",
          `The sandbox rigd at ${root} did not start.`,
          "Read the rigd output in this Service's log, then restart the Service.",
          { root, exitCode, output },
        );
    },
    /** Stops the daemon. rigd refuses while a sandbox Target still runs; it is then left running
     * and `false` is returned, and the next start finds it again. */
    async stop(): Promise<boolean> {
      return (await run("uninstall")).exitCode === 0;
    },
  };
}
