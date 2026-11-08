import { rm } from "node:fs/promises";
import {
  awaitExit,
  platformInspect,
  signalOwned,
  type Inspect,
} from "./rig-fixture";

/** What a test run left: each fixture's root and the processes it ran, by pid and birth. */
export type Report = {
  base: string;
  processes: { pid: number; identity?: string }[];
};
/** Stops what a run left behind while it is still the process reported, and removes each root once it has. `inspect` is
 * the `ps` it reads processes with. */
export async function stopLeftBehind(
  reports: readonly Report[],
  inspect: Inspect = platformInspect,
) {
  for (const report of reports) {
    for (const { pid, identity } of report.processes) {
      if (identity === undefined) continue;
      const owned = { pid, identity };
      if (signalOwned(owned, "SIGTERM", inspect) === "gone") continue;
      if ((await awaitExit(owned, inspect)) !== "gone")
        signalOwned(owned, "SIGKILL", inspect);
      // Sent or not, since a SIGKILL is skipped on any read that does not show the process: the root goes only once the
      // wait sees it gone.
      const exit = await awaitExit(owned, inspect);
      if (exit !== "gone")
        throw new Error(
          exit === "running"
            ? `process ${pid} is still running; its root is kept at ${report.base}`
            : `the reads of process ${pid} were inconclusive, so it may still run; its root is kept at ${report.base}`,
        );
    }
    await rm(report.base, { recursive: true, force: true });
  }
}
