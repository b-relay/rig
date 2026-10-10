import type { ProjectEntry } from "./board-rows";
import { orderedTargets } from "./overview";
import { routeLines } from "./target-detail";
import type { TargetReport } from "./types";

/* The Proxy page reads through this module. Today every hostname comes from rigd's status, which knows
 * each Target's hostname and path routes. A Rig-owned Caddy (ADR 0014, branch feat/rig-owned-caddy) will
 * list every hostname with its upstream itself and keep a user-owned custom Caddy file beside Rig's own;
 * the custom file is a typed stub until then.
 * TODO(feat/rig-owned-caddy): read hostnames and the custom file from rigd's proxy read, and save the
 * custom file through its editor route. */

/** One hostname and path Caddy serves, and the loopback Service it reaches. */
export interface ProxyRoute {
  host: string;
  /** The URL a browser opens. */
  url: string;
  prefix: string;
  project: string;
  target: string;
  kind: TargetReport["kind"];
  service: string;
  /** `127.0.0.1:<port>`, when the port is known. */
  upstream?: string;
  /** The Target's state, so a route to a stopped Target reads as such. */
  state: string;
  /** False when the Host's Caddy does not load Rig's route file, so the route is inert. */
  published: boolean;
}
/** Pure: every route on the Host from each Project's status, by host and then longest prefix first. */
export function proxyRoutes(entries: readonly ProjectEntry[]): ProxyRoute[] {
  return entries
    .flatMap(({ project, status }) =>
      status?.ok
        ? orderedTargets(status.value.targets).flatMap((target) =>
            routeLines(target).map((line) => ({
              host: new URL(line.url).host,
              url: line.url,
              prefix: line.prefix,
              project: project.name,
              target: target.name,
              kind: target.kind,
              service: line.service,
              ...(line.port !== undefined
                ? { upstream: `127.0.0.1:${line.port}` }
                : {}),
              state: target.state,
              published: target.routePublished !== false,
            })),
          )
        : [],
    )
    .sort(
      (a, b) =>
        a.host.localeCompare(b.host) || b.prefix.length - a.prefix.length,
    );
}
/** The Caddy file the operator owns beside Rig's generated routes. */
export interface CustomCaddyFile {
  path: string;
  raw: string;
  /** What a save must name, so a file changed in between is refused. */
  revision: string;
}
/** What the Proxy page can say about the custom Caddy file. */
export type CustomCaddy =
  | { supported: false; reason: string }
  | { supported: true; file: CustomCaddyFile };
/** The custom Caddy file, once rigd owns Caddy; until then, why there is none. */
export async function customCaddyFile(): Promise<CustomCaddy> {
  // TODO(feat/rig-owned-caddy): read it from rigd.
  return {
    supported: false,
    reason:
      "Rig does not run its own Caddy yet. Once it does (ADR 0014), the Caddy file you own beside Rig's routes is edited here.",
  };
}
