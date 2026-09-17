import { connect } from "node:net";
import type { HealthCheck } from "./contracts";

/** Whether something accepts a TCP connection on a local port right now. It does not say who: ownership of the listener is
 * separate evidence. Never rejects; an aborted probe is not ready. */
export type PortProbe = (
  port: number,
  signal: AbortSignal,
) => Promise<HealthCheck>;

/** Tries IPv4 loopback, then IPv6 loopback, so a Service bound to either one is found. */
export const probeLocalPort: PortProbe = async (port, signal) => {
  let reason = "";
  for (const host of ["127.0.0.1", "::1"]) {
    const failure = await attempt(host, port, signal);
    if (failure === undefined) return { ready: true };
    reason ||= failure;
  }
  return { ready: false, reason: `port ${port}: ${reason}` };
};
function attempt(
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve("cancelled");
    const socket = connect({ host, port });
    const settle = (failure?: string) => {
      signal.removeEventListener("abort", cancelled);
      socket.destroy();
      resolve(failure);
    };
    const cancelled = () => settle("cancelled");
    signal.addEventListener("abort", cancelled, { once: true });
    socket.setTimeout(2000, () => settle("timed out after 2s"));
    socket.once("connect", () => settle());
    socket.once("error", (error: NodeJS.ErrnoException) =>
      settle(error.code ?? error.message),
    );
  });
}
