import { createServer } from "node:net";
import { RigError } from "../domain/errors";
import type { RuntimeFiles } from "../runtime/contracts";
import { readTargetLogs } from "./target-log-reader";
/** Binds only localhost while choosing ports; process providers remain responsible for startup races. */
export function createRuntimeFiles(): RuntimeFiles {
  return {
    async reservePorts(requests, occupied, dynamic) {
      const selected: Record<string, number> = {},
        used = new Set(occupied);
      for (const request of requests) {
        if (request.preferred && used.has(request.preferred) && !dynamic)
          throw new RigError(
            "PORT_RESERVED",
            `Port ${request.preferred} is reserved by another Target.`,
            "Configure a distinct local/live port.",
          );
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
