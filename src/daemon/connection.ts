import { DaemonClient, type DaemonClientOptions } from "./client";
import { readDaemonAddress, readDaemonToken } from "./files";
import { recordedProcess, type ProcessLiveness } from "./process-identity";
import { RigError } from "../domain/errors";
import type { DaemonAddress } from "./protocol";

/** Acquire fresh Host discovery and credentials for one transport operation. No probe or retry.
 * The credential is only handed to a port whose recorded owner process is verified to still run;
 * any other record is reported as stale, never contacted. */
export async function connectDaemon(
  root: string,
  options: DaemonClientOptions = {},
): Promise<DaemonClient> {
  return new DaemonClient(await liveDaemonAddress(root), options);
}
/** Why a record whose process is not verified running is stale. */
const staleBecause: Record<Exclude<ProcessLiveness, "running">, string> = {
  exited: "has exited",
  replaced: "now belongs to another process",
  unverified: "is alive, but the record has no start time to verify it by",
};
/** The port and credential of the daemon whose recorded process is verified to still be the one that wrote the
 * record. rig and the dashboard both discover rigd through this, and the token is read only once it passes. */
export async function liveDaemonAddress(root: string): Promise<DaemonAddress> {
  const address = await readDaemonAddress(root);
  if (!address)
    throw new RigError(
      "DAEMON_MISSING",
      "rigd is not installed or reachable.",
      "Run rigd install to start the daemon.",
    );
  const liveness = await recordedProcess(address);
  if (liveness !== "running")
    throw new RigError(
      "DAEMON_UNREACHABLE",
      `rigd is not running; its address record is stale (pid ${address.pid} ${staleBecause[liveness]}).`,
      "Run 'rigd status'; 'rigd install' starts the daemon again.",
      { pid: address.pid, port: address.port },
    );
  return { port: address.port, token: await readDaemonToken(root) };
}

/** Missing setup and transport unreachability permit read-only offline diagnosis. */
export function isDaemonUnavailable(error: unknown): boolean {
  return (
    error instanceof RigError &&
    ["DAEMON_MISSING", "DAEMON_UNREACHABLE"].includes(error.code)
  );
}
