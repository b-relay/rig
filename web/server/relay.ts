import type { DaemonAddress } from "../../src/daemon/protocol";

/** The three routes rigd serves, by the path the dashboard calls. */
export const RELAYED = {
  "/api/health": { path: "/health", method: "GET" },
  "/api/command": { path: "/v1/command", method: "POST" },
  "/api/config": { path: "/v1/config", method: "POST" },
} as const;
export type RelayedPath = keyof typeof RELAYED;
export interface RelayDependencies {
  /** Fresh discovery per request, as rig does it: a restarted rigd has a new port. Rejects with a coded error when rigd is not running. */
  address(): Promise<DaemonAddress>;
  send(url: string, init: RequestInit): Promise<Response>;
}
const failure = (status: number, code: string, message: string, hint: string) =>
  Response.json({ error: { code, message, hint } }, { status });
/** Forwards one admitted request to rigd with the Host credential and answers with rigd's own
 * status and body. The credential never appears in a reply. */
export function createRelay(dependencies: RelayDependencies) {
  return async (
    route: RelayedPath,
    body: string | undefined,
    /** Aborts when the browser gives up. rigd finishes a mutation it already accepted either way. */
    abandoned?: AbortSignal,
  ): Promise<Response> => {
    const target = RELAYED[route];
    let address: DaemonAddress;
    try {
      address = await dependencies.address();
    } catch (error) {
      const known = error as {
        code?: unknown;
        message?: unknown;
        hint?: unknown;
      };
      return failure(
        503,
        typeof known.code === "string" ? known.code : "DAEMON_UNREACHABLE",
        typeof known.message === "string"
          ? known.message
          : "rigd is not reachable.",
        typeof known.hint === "string" ? known.hint : "Run 'rigd status'.",
      );
    }
    let answer: Response;
    try {
      answer = await dependencies.send(
        `http://127.0.0.1:${address.port}${target.path}`,
        {
          method: target.method,
          headers: {
            authorization: `Bearer ${address.token}`,
            "content-type": "application/json",
          },
          ...(target.method === "POST" ? { body: body ?? "" } : {}),
          redirect: "error",
          ...(abandoned ? { signal: abandoned } : {}),
        },
      );
    } catch {
      return failure(
        503,
        "DAEMON_UNREACHABLE",
        "rigd is not reachable.",
        "Run 'rigd status' to inspect the daemon.",
      );
    }
    let text: string;
    try {
      text = await answer.text();
    } catch {
      // The browser gave up mid-reply; nothing is listening, so any status will do.
      return failure(
        502,
        "RELAY_INTERRUPTED",
        "The reply from rigd was cut short.",
        "Retry the request.",
      );
    }
    return new Response(text, {
      status: answer.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  };
}
