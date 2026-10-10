import type { CaddyAdmin } from "./managed-caddy";

/** Caddy's admin API on its Unix socket: whether it answers, what it serves, and a graceful stop. */
export interface CaddyAdminClient extends CaddyAdmin {
  /** The running config as JSON, or undefined when the socket does not answer. */
  config(): Promise<unknown>;
  /** Asks Caddy to exit gracefully; false when the socket did not take the request. */
  stop(): Promise<boolean>;
}
export function createCaddyAdmin(
  socket: string,
  timeoutMs = 2000,
): CaddyAdminClient {
  const call = async (path: string, method = "GET") => {
    try {
      return await fetch(`http://localhost${path}`, {
        method,
        unix: socket,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return undefined;
    }
  };
  return {
    async reachable() {
      const response = await call("/config/");
      await response?.body?.cancel().catch(() => {});
      return response?.ok ?? false;
    },
    async config() {
      const response = await call("/config/");
      if (!response?.ok) return undefined;
      return response.json().catch(() => undefined);
    },
    async stop() {
      const response = await call("/stop", "POST");
      await response?.body?.cancel().catch(() => {});
      return response?.ok ?? false;
    },
  };
}
