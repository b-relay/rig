import { destroyPreview, inspectPreviewDeletion } from "./preview-storage";
import { createServer } from "node:net";
import { RigError } from "../domain/errors";
import type { RuntimeFiles } from "../runtime/contracts";
import { readTargetLogs } from "./target-log-reader";
/** Binds only localhost while choosing ports; process providers remain responsible for startup races. */
export function createRuntimeFiles(): RuntimeFiles {
  return {
    destroyPreview,
    inspectPreviewDeletion,
    async selectPorts({ requests, occupied, policy }) {
      const dynamic = policy === "dynamic";
      const selected: Record<string, number> = {},
        used = new Set(occupied.keys());
      for (const request of requests) {
        if (request.preferred && used.has(request.preferred) && !dynamic) {
          const owner = occupied.get(request.preferred);
          throw new RigError(
            "PORT_RESERVED",
            owner
              ? `Port ${request.preferred} pinned for Service '${request.name}' belongs to Target '${owner.target}' of Project '${owner.project}'.`
              : `Port ${request.preferred} is pinned for more than one Service.`,
            "Pin a different port for this Target, or change or destroy the Target that holds it. Rig keeps ports apart among its own Targets only; it does not reserve them against other processes.",
            {
              port: request.preferred,
              service: request.name,
              ...(owner ? { owner } : {}),
            },
          );
        }
        let port = await availablePort(dynamic ? 0 : (request.preferred ?? 0));
        while (used.has(port)) port = await availablePort(0);
        used.add(port);
        selected[request.name] = port;
      }
      return selected;
    },
    logs: readTargetLogs,
  };
}
async function availablePort(preferred: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new RigError(
          "PORT_UNAVAILABLE",
          `Port ${preferred || "allocation"} is unavailable.`,
          "Stop the conflicting process or configure another port.",
        ),
      ),
    );
    server.listen(preferred, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
