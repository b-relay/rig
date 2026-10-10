import { createHash } from "node:crypto";
import { RigError } from "../domain/errors";

/** One path prefix of a hostname. It matches the prefix itself and everything below its next slash, and the upstream sees the
 * path unchanged. A `null` upstream is withheld: its requests are answered 503 and reach no process. */
export interface RoutePath {
  readonly prefix: string;
  readonly upstream: string | null;
}
/** The whole route map of one hostname, in matching order: the first path that matches a request takes it, so the caller lists
 * longer prefixes first. '/' must be among them. */
export interface RouteSite {
  readonly hostname: string;
  readonly routes: readonly RoutePath[];
}
/** Every hostname one owner (a Target) publishes. They are written, checkpointed, restored and withdrawn together, so a Target
 * with several hostnames is never half published. */
export interface RouteRequest {
  readonly key: string;
  readonly sites: readonly RouteSite[];
}
/** One withheld path of a published site. */
export interface WithheldPath {
  readonly hostname: string;
  readonly prefix: string;
}
export interface RouteCheckpoint {
  readonly key: string;
  readonly value: string | null;
}
/** Publishes route blocks. Every change takes effect in the proxy before it resolves, or fails and leaves what was served. */
export interface Router {
  apply(route: RouteRequest): Promise<void>;
  remove(key: string): Promise<void>;
  /** The paths of the published sites that reach no process; empty without a route. */
  withheld(key: string): Promise<WithheldPath[]>;
  checkpoint(key: string): Promise<RouteCheckpoint>;
  restore(saved: RouteCheckpoint, expected: RouteCheckpoint): Promise<void>;
}

/** One change to the route file, worked out from its text alone. */
export interface RouteEdit {
  readonly after: string;
  /** The change withholds a path. It is published even when the file already says so: what Caddy serves can differ from the
   * file after a reload that failed, and a process is about to start or stop behind whatever Caddy serves now. */
  readonly withdrawing: boolean;
}
/** The route file after setting (`route`), removing (neither) or restoring (`restoration`) the block owned by `key`; undefined
 * when nothing is owned and nothing is added. Refuses an invalid request (ROUTE_INVALID), a hostname another block or
 * `reserved` serves (ROUTE_CONFLICT) and a restoration whose block changed since its checkpoint (ROUTE_CHANGED). */
export function editRouteFile(input: {
  readonly before: string;
  readonly key: string;
  readonly route?: RouteRequest;
  readonly restoration?: {
    readonly saved: RouteCheckpoint;
    readonly expected: RouteCheckpoint;
  };
  /** Directives added inside every site block, after its paths. */
  readonly siteConfig: readonly string[];
  /** Hostnames served outside the route file, such as the owner's custom sites, with what to name as their owner. */
  readonly reserved?: {
    readonly sites: readonly string[];
    readonly owner: string;
  };
}): RouteEdit | undefined {
  const { before, key, route, restoration } = input;
  if (route) validateRequest(route);
  if (
    restoration &&
    (restoration.saved.key !== key ||
      restoration.expected.key !== key ||
      ownedBlock(before, key) !== restoration.expected.value)
  )
    throw new RigError(
      "ROUTE_CHANGED",
      "The route changed after its checkpoint.",
      "Inspect the current route before retrying recovery.",
    );
  const existing = restoration
    ? restoration.expected.value
    : ownedBlock(before, key);
  const without = existing === null ? before : before.replace(existing, "");
  const taken = route?.sites.find((site) =>
    hostnamePresent(without, site.hostname),
  );
  if (taken)
    throw new RigError(
      "ROUTE_CONFLICT",
      "This hostname is already owned by another route.",
      "Choose a different hostname or explicitly migrate its existing owner.",
      { hostname: taken.hostname },
    );
  const reserved = route?.sites.find((site) =>
    input.reserved?.sites.some(
      (address) => siteAddress(address) === siteAddress(site.hostname),
    ),
  );
  if (reserved)
    throw new RigError(
      "ROUTE_CONFLICT",
      `The hostname ${reserved.hostname} is served by ${input.reserved!.owner}.`,
      `Remove its site from ${input.reserved!.owner} and run rig proxy reload, or choose a different hostname.`,
      { hostname: reserved.hostname, owner: input.reserved!.owner },
    );
  const block = restoration
    ? (restoration.saved.value ?? "")
    : route
      ? renderOwnedBlock(route, input.siteConfig)
      : "";
  if (!block && existing === null) return undefined;
  return {
    after: without + (without && !without.endsWith("\n") ? "\n" : "") + block,
    withdrawing:
      route?.sites.some((site) =>
        site.routes.some((path) => path.upstream === null),
      ) ?? false,
  };
}

/** Refuses a request Caddy could misread or that would reach beyond this machine: every site needs a valid hostname that no
 * other site of the request repeats, a '/' path and localhost upstreams. */
function validateRequest(route: RouteRequest): void {
  const invalid = () =>
    new RigError(
      "ROUTE_INVALID",
      "The route address is invalid.",
      "Use a valid hostname and a localhost upstream.",
    );
  if (!route.sites.length) throw invalid();
  const seen = new Set<string>();
  for (const site of route.sites) {
    if (
      !/^(?:https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9.\-]*(?::\d{1,5})?$/.test(
        site.hostname,
      ) ||
      !site.routes.some((path) => path.prefix === "/") ||
      site.routes.some(
        (path) =>
          !/^\/[A-Za-z0-9._~\/-]*$/.test(path.prefix) ||
          (path.upstream !== null &&
            !/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(
              path.upstream,
            )),
      )
    )
      throw invalid();
    const address = siteAddress(site.hostname);
    if (seen.has(address))
      throw new RigError(
        "ROUTE_INVALID",
        `The hostname ${site.hostname} is listed twice for one Target.`,
        "Give each hostname of a Target one entry.",
        { hostname: site.hostname },
      );
    seen.add(address);
  }
}
/** The marked block that holds every site of `route`. */
export function renderOwnedBlock(
  route: RouteRequest,
  siteConfig: readonly string[],
): string {
  const { begin, end } = routeMarkers(route.key);
  return `${begin}\n${route.sites.map((site) => siteBlock(site, siteConfig)).join("")}${end}\n`;
}
/** One Caddy site: its paths, then the Host's extra directives. Its header is the only line of a Rig block that starts at
 * column 0 and ends with `{`, which is how `parseOwnedSites` tells the sites apart. */
function siteBlock(site: RouteSite, siteConfig: readonly string[]): string {
  return `${site.hostname} {\n${siteRoutes(site.routes)}${siteConfig.map((line) => "  " + line + "\n").join("")}}\n`;
}
/** A lone '/' is the site's one handler. Several paths become mutually exclusive `handle` blocks in the given order; each
 * matcher names the prefix and its subtree, so '/api' never takes '/apix'. */
function siteRoutes(routes: readonly RoutePath[]): string {
  const handler = (path: RoutePath) =>
    path.upstream === null ? "respond 503" : `reverse_proxy ${path.upstream}`;
  if (routes.length === 1) return `  ${handler(routes[0]!)}\n`;
  return routes
    .map((path, index) =>
      path.prefix === "/"
        ? `  handle {\n    ${handler(path)}\n  }\n`
        : `  @rig${index} path ${path.prefix} ${path.prefix}/*\n  handle @rig${index} {\n    ${handler(path)}\n  }\n`,
    )
    .join("");
}
/** Reads back what `renderOwnedBlock` wrote: each site with its paths in order. Lines that are not paths, such as the Host's
 * extra directives, are not part of a site's routes. */
export function parseOwnedSites(block: string): RouteSite[] {
  const sites: { hostname: string; routes: RoutePath[] }[] = [];
  let matchers = new Map<string, string>();
  let prefix: string | undefined;
  for (const raw of block.split(/\r?\n/)) {
    const header = /^(\S+) \{$/.exec(raw);
    if (header) {
      sites.push({ hostname: header[1]!, routes: [] });
      matchers = new Map();
      prefix = undefined;
      continue;
    }
    const site = sites.at(-1);
    if (!site) continue;
    const line = raw.trim();
    const matcher = /^(@rig\d+) path (\S+) /.exec(line);
    if (matcher) matchers.set(matcher[1]!, matcher[2]!);
    const handle = /^handle(?: (@rig\d+))? \{$/.exec(line);
    if (handle) prefix = handle[1] ? (matchers.get(handle[1]) ?? "/") : "/";
    const upstream = /^reverse_proxy (\S+)$/.exec(line)?.[1];
    if (upstream !== undefined || line === "respond 503")
      site.routes.push({ prefix: prefix ?? "/", upstream: upstream ?? null });
  }
  return sites;
}
/** Reads back what a Rig block publishes: for each site, the prefixes whose handler is `respond 503`. */
export function withheldPaths(block: string): WithheldPath[] {
  return parseOwnedSites(block).flatMap((site) =>
    site.routes
      .filter((path) => path.upstream === null)
      .map((path) => ({ hostname: site.hostname, prefix: path.prefix })),
  );
}
/** Every owned block rendered again with `siteConfig`, leaving everything else in the file as it is. A file whose blocks
 * already carry these directives comes back unchanged. */
export function rerenderOwnedBlocks(
  text: string,
  siteConfig: readonly string[],
): string {
  return text.replace(
    /# rig begin ([0-9a-f]{64})\r?\n([\s\S]*?)# rig end \1(\r?\n)?/g,
    (whole, token: string, body: string) => {
      const sites = parseOwnedSites(body);
      if (!sites.length) return whole;
      const lines = [`# rig begin ${token}`];
      for (const site of sites)
        lines.push(siteBlock(site, siteConfig).replace(/\n$/, ""));
      lines.push(`# rig end ${token}`);
      return lines.join("\n") + "\n";
    },
  );
}
/** Every hostname the owned blocks of a route file serve. */
export function routeFileHostnames(text: string): string[] {
  return [
    ...text.matchAll(/# rig begin ([0-9a-f]{64})\r?\n([\s\S]*?)# rig end \1/g),
  ].flatMap((match) => parseOwnedSites(match[2]!).map((site) => site.hostname));
}
/** Caddy serves one site per host and port; a bare address defaults to 443 (80 under http://), so `example.com` and
 * `example.com:443` are one site and `example.com:8443` is another. */
export function siteAddress(address: string): string {
  const scheme = /^http:\/\//i.test(address) ? "http" : "https";
  const bare = address.replace(/^https?:\/\//i, "").toLowerCase();
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(bare)!;
  return `${match[1]}:${match[2] ?? (scheme === "http" ? "80" : "443")}`;
}
function hostnamePresent(text: string, hostname: string): boolean {
  const canonical = siteAddress(hostname);
  return text.split("\n").some((line) => {
    const header = line.trim().replace(/\s*#.*$/, "");
    if (!header.endsWith("{")) return false;
    return header
      .slice(0, -1)
      .split(/[\s,]+/)
      .filter(Boolean)
      .some((address) => siteAddress(address) === canonical);
  });
}
function routeMarkers(key: string): { begin: string; end: string } {
  const token = createHash("sha256").update(key).digest("hex");
  return { begin: `# rig begin ${token}`, end: `# rig end ${token}` };
}
/** Reads the complete owned block, including its newline, or rejects incomplete markers. */
export function ownedBlock(text: string, key: string): string | null {
  const { begin, end } = routeMarkers(key);
  const start = text.indexOf(begin),
    finish = text.indexOf(end);
  if (start >= 0 !== finish >= 0 || (start >= 0 && finish < start))
    throw new RigError(
      "ROUTE_CORRUPT",
      "A managed route marker is incomplete.",
      "Repair the Caddyfile before changing routes.",
    );
  if (start < 0) return null;
  const endPosition = finish + end.length;
  return (
    text.slice(start, endPosition) +
    (text.slice(endPosition).startsWith("\r\n")
      ? "\r\n"
      : text[endPosition] === "\n"
        ? "\n"
        : "")
  );
}
