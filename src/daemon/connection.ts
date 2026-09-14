import { DaemonClient } from "./client";
import { readDaemonAddress, readDaemonToken } from "./files";
import { processExists } from "./host";
import { RigError } from "../domain/errors";

/** Acquire fresh Host discovery and credentials for one transport operation. No probe or retry.
 * The credential is only handed to a port whose recorded owner process still exists;
 * a record left behind by a dead daemon is reported as stale, never contacted. */
export async function connectDaemon(root: string): Promise<DaemonClient> {
  const address = await readDaemonAddress(root);
  if (!address)
    throw new RigError(
      "DAEMON_MISSING",
      "rigd is not installed or reachable.",
      "Run rigd install to start the daemon.",
    );
  if (!processExists(address.pid))
    throw new RigError(
      "DAEMON_UNREACHABLE",
      `rigd is not running; its address record is stale (pid ${address.pid} has exited).`,
      "Run 'rigd status'; 'rigd install' starts the daemon again.",
      { pid: address.pid, port: address.port },
    );
  return new DaemonClient({
    port: address.port,
    token: await readDaemonToken(root),
  });
}

/** Missing setup and transport unreachability permit read-only offline diagnosis. */
export function isDaemonUnavailable(error: unknown): boolean {
  return error instanceof RigError &&
    ["DAEMON_MISSING", "DAEMON_UNREACHABLE"].includes(error.code);
}
