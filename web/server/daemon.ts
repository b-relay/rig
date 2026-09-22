import { DaemonClient } from "../../src/daemon/client";
import { readDaemonAddress, readDaemonToken } from "../../src/daemon/files";
import type { DaemonAddress } from "../../src/daemon/protocol";
import { RigError } from "../../src/domain/errors";
import type {
  Action,
  ConfigEditorRequest,
  Reply,
  RuntimeCommand,
} from "../lib/types";
import { site } from "./site";

/** Fresh discovery per request, as rig does it: a restarted rigd has a new port. The health
 * probe, not a process check, tells whether the recorded daemon is alive. */
export async function daemonAddress(root: string): Promise<DaemonAddress> {
  const address = await readDaemonAddress(root);
  if (!address)
    throw new RigError(
      "DAEMON_MISSING",
      "rigd is not installed or reachable.",
      "Run rigd install to start the daemon.",
    );
  return { port: address.port, token: await readDaemonToken(root) };
}
/** The site's rigd: the Host's, or the sandbox's when this copy is a Preview. */
export async function daemon(): Promise<DaemonClient> {
  return new DaemonClient(await daemonAddress(site().root));
}
/** One command, answered with the reply its action carries. Reads keep rigd's deadlines; a
 * mutation waits as long as rigd takes. */
export async function read<A extends Action>(
  command: RuntimeCommand & { action: A },
  signal?: AbortSignal,
): Promise<Reply<A>> {
  return (await (await daemon()).command(command, signal)) as Reply<A>;
}
const protocolFailure = () =>
  new RigError(
    "DAEMON_PROTOCOL",
    "rigd returned an invalid response.",
    "Check that rig and rigd use the same version.",
  );
/** The config editor route, which rig itself does not call: a read, a preview, or an apply. */
export async function editConfig(
  request: ConfigEditorRequest,
): Promise<unknown> {
  const address = await daemonAddress(site().root);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${address.port}/v1/config`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${address.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      redirect: "error",
    });
  } catch {
    throw new RigError(
      "DAEMON_UNREACHABLE",
      "rigd is not reachable.",
      "Run 'rigd status' to inspect the daemon.",
    );
  }
  const payload = (await response.json().catch(() => undefined)) as
    | {
        result?: unknown;
        error?: { code?: string; message?: string; hint?: string };
      }
    | undefined;
  if (!payload || typeof payload !== "object") throw protocolFailure();
  if (!response.ok) {
    const error = payload.error;
    if (typeof error?.code !== "string" || typeof error.message !== "string")
      throw protocolFailure();
    throw new RigError(
      error.code,
      error.message,
      error.hint ?? "Run 'rigd status'.",
    );
  }
  if (!Object.hasOwn(payload, "result")) throw protocolFailure();
  return payload.result;
}
