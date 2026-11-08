import { DaemonClient } from "./client";
import { readDaemonAddress, readDaemonToken } from "./files";
import { RigError } from "../domain/errors";

export const pause = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Asks the serving rigd to ready itself to stop (`prepare-stop`): it has Rig's Caddy withhold the dashboard's domain and
 * stops its dashboard once Caddy confirms that. A rigd that cannot keeps serving, reachable, and this fails with its reason
 * (DAEMON_STOP). An older rigd, which has no such step, stops as before. Without `client`, the rigd the address record of
 * `root` names is asked. */
export async function prepareStop(
  root: string,
  client?: DaemonClient,
): Promise<void> {
  const address = client ? undefined : await readDaemonAddress(root);
  const daemon =
    client ??
    new DaemonClient({
      port: address!.port,
      token: await readDaemonToken(root),
    });
  try {
    await daemon.command({ action: "prepare-stop" });
  } catch (error) {
    if (error instanceof RigError && error.code === "DAEMON_PROTOCOL") return;
    const reason = error instanceof Error ? error.message : String(error);
    throw new RigError(
      "DAEMON_STOP",
      `The running rigd could not stop safely, so it keeps serving: ${reason}`,
      error instanceof RigError && error.hint
        ? `${error.hint} Then run this command again.`
        : "Run rigd status and rig doctor, then run this command again.",
      { reason },
    );
  }
}
/** Whether `running` stops holding within `timeoutMs`, asked every 50 ms and once more at the end. */
export async function stopsWithin(
  running: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ((await running()) && Date.now() < deadline) await pause(50);
  return !(await running());
}
