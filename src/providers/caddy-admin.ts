import { caddyConfigSchema } from "../domain/caddy-config";
import { RigError } from "../domain/errors";
import type { CaddyAdmin } from "./managed-caddy";

/** Caddy's admin API on its Unix socket: whether it answers, what it serves, and a graceful stop. */
export interface CaddyAdminClient extends CaddyAdmin {
  /** The running config as JSON, null when Caddy has loaded none, or undefined when the socket does not answer or its
   * reply is not JSON. JSON that is not a configuration is refused (PROXY_PROTOCOL). */
  config(): Promise<unknown>;
  /** Asks Caddy to exit gracefully; false when the socket did not take the request. */
  stop(): Promise<boolean>;
}
/** How long Caddy may take to load a configuration (provisioning its apps) before rigd gives up waiting. */
const LOAD_TIMEOUT_MS = 60_000;
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
      // A reply cut short is no answer, as before; a Caddy that has loaded nothing answers null.
      const body = await response.json().then(
        (value: unknown) => ({ value }),
        () => undefined,
      );
      if (!body) return undefined;
      const config = caddyConfigSchema.nullable().safeParse(body.value);
      if (!config.success)
        throw new RigError(
          "PROXY_PROTOCOL",
          "Rig's Caddy answered GET /config/ with something other than a Caddy configuration.",
          `Check that ${socket} is the admin socket of Rig's Caddy, then run rigd install, which restarts it.`,
          { socket },
        );
      return config.data;
    },
    async load(config, signal) {
      // No answer (cancelled, timed out, the socket closed) is thrown, never told apart from a refusal: Caddy may still
      // hold the whole request, and apply it.
      const response = await fetch("http://localhost/load", {
        method: "POST",
        unix: socket,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
        signal: AbortSignal.any([
          AbortSignal.timeout(LOAD_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]),
      });
      const text = await response.text().catch(() => "");
      if (response.ok) return undefined;
      const error = (() => {
        try {
          return (JSON.parse(text) as { error?: unknown }).error;
        } catch {
          return undefined;
        }
      })();
      return typeof error === "string" && error
        ? error
        : text.trim() || `HTTP ${response.status}`;
    },
    async stop() {
      const response = await call("/stop", "POST");
      await response?.body?.cancel().catch(() => {});
      return response?.ok ?? false;
    },
  };
}
