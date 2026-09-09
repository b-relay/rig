import { DaemonClient } from "./client";
import { readDaemonAddress, readDaemonToken } from "./files";
import { RigError } from "../domain/errors";

/** Acquire fresh Host discovery and credentials for one transport operation. No probe or retry. */
export async function connectDaemon(root: string): Promise<DaemonClient> {
  const address = await readDaemonAddress(root);
  if (!address)
    throw new RigError(
      "DAEMON_MISSING",
      "rigd is not installed or reachable.",
      "Run rigd install to start the daemon.",
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
