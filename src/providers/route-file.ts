import { RigError } from "../domain/errors";
import { ownedRouteBlocks, routeOwnerToken } from "../domain/proxy-publication";
import { bareHostname } from "../domain/managed-proxy";
import { checkCaddyValue } from "../domain/caddy-value";

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
  /** Refuses `route` as `apply` would (ROUTE_INVALID, ROUTE_CONFLICT) without changing anything, so a deploy learns before it
   * stops the previous Deployment that its route cannot be published. A route with no sites (a route-free plan) checks
   * nothing; a router that reserves still reserves what the Target serves now. */
  check?(route: RouteRequest): Promise<void>;
  /** Lets go of the hostnames `check` reserved for `key`, once the deployment that asked is decided. */
  release?(key: string): Promise<void>;
  /** Withdraws, as one change published like any other, every owned block whose key `owners` does not hold: a route whose
   * Target no longer exists, which would otherwise hold its hostnames from every new owner. `owners` is asked inside the
   * router's queue, after every change queued before this one, so a block published for a Target recorded meanwhile is
   * never taken for an orphan (every Target is recorded before its route is published). Resolves with the hostnames
   * withdrawn; with none to withdraw it publishes nothing and asks nothing of the proxy. Fails as `remove` fails (such as
   * PROXY_UNREACHABLE), with the route file as it was. With `confinement`, the route file's real path is resolved once,
   * inside the queue, and nothing is withdrawn unless it lies inside `confinement.within`; that resolved file is the one
   * read and written, and the write is refused (ROUTE_CHANGED) when the route file stops resolving to it meanwhile. */
  withdrawUnowned(
    owners: () => Promise<ReadonlySet<string>>,
    confinement?: { readonly within: string },
  ): Promise<string[]>;
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
  /** Hostnames served outside the route file, such as the owner's proxy.routes, with what to name as their owner. */
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
  if (taken) {
    // The Target block that holds it, when one does, so a caller holding Target state can tell one whose Target is gone.
    const holder = ownedRouteBlocks(without).find((block) =>
      block.hostnames.some(
        (hostname) => siteAddress(hostname) === siteAddress(taken.hostname),
      ),
    );
    throw new RigError(
      "ROUTE_CONFLICT",
      "This hostname is already owned by another route.",
      "Choose a different hostname or explicitly migrate its existing owner.",
      {
        hostname: taken.hostname,
        ...(holder ? { routeTokens: [holder.token] } : {}),
      },
    );
  }
  // By bare hostname: Caddy merges two blocks for one name written with different schemes or ports, so a port does not set
  // them apart.
  const reserved = route?.sites.find((site) =>
    input.reserved?.sites.some(
      (address) => bareHostname(address) === bareHostname(site.hostname),
    ),
  );
  if (reserved)
    throw new RigError(
      "ROUTE_CONFLICT",
      `The hostname ${reserved.hostname} is served by ${input.reserved!.owner}.`,
      `Remove it from ${input.reserved!.owner} and run rig proxy reload, or choose a different hostname.`,
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
/** One Caddy site: its paths, then the Host's extra directives (an external router's `extra_config`; Rig's own Caddy has
 * none). Its header is the only line of a Rig block that starts at column 0 and ends with `{`, which is how
 * `parseOwnedSites` tells the sites apart. Values pass `checkCaddyValue` and stay unquoted: the file's format is a contract
 * with the external router and the parser here, and a value that passes needs no quoting. */
function siteBlock(site: RouteSite, siteConfig: readonly string[]): string {
  return `${checkCaddyValue("address", site.hostname)} {\n${siteRoutes(site.routes)}${siteConfig.map((line) => "  " + line + "\n").join("")}}\n`;
}
/** A lone '/' is the site's one handler. Several paths become mutually exclusive `handle` blocks in the given order; each
 * matcher names the prefix and its subtree, so '/api' never takes '/apix'. */
function siteRoutes(routes: readonly RoutePath[]): string {
  const handler = (path: RoutePath) =>
    path.upstream === null
      ? "respond 503"
      : `reverse_proxy ${checkCaddyValue("upstream", path.upstream)}`;
  for (const path of routes) checkCaddyValue("prefix", path.prefix);
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
/** The route file as Rig's own Caddy publishes it: rendered entirely from the sites parsed out of its owned blocks, with no
 * directive of any config. Nothing of the existing text is kept as text: whatever lies outside the markers (an external
 * router's `extra_config` that ended a block early, an edit), any line in a block that is not one of its paths, and a site
 * whose values fail `checkCaddyValue` or that has no '/' path are dropped. `dropped` says whether anything was. */
export function canonicalRouteFile(text: string): {
  text: string;
  dropped: boolean;
} {
  const blocks = [
    ...text.matchAll(
      /# rig begin ([0-9a-f]{64})\r?\n([\s\S]*?)# rig end \1(?:\r?\n)?/g,
    ),
  ].flatMap((match) => {
    const sites = parseOwnedSites(match[2]!).flatMap((site) => {
      if (!site.routes.some((path) => path.prefix === "/")) return [];
      try {
        return [siteBlock(site, []).replace(/\n$/, "")];
      } catch {
        return [];
      }
    });
    return sites.length
      ? [
          [`# rig begin ${match[1]}`, ...sites, `# rig end ${match[1]}`].join(
            "\n",
          ) + "\n",
        ]
      : [];
  });
  const canonical = blocks.join("");
  return { text: canonical, dropped: canonical !== text };
}
/** The one invariant every publication keeps, checked where the route file (and, for Rig's Caddy, the generation) is
 * written: a hostname belongs to exactly one owner, one Target's block or one `outside` entry such as an owner route in
 * `proxy.routes`. `identity` says when two addresses are one site: the bare hostname for Rig's Caddy, which merges blocks
 * across schemes and ports; `siteAddress` for an external Caddy. Refuses with ROUTE_CONFLICT naming both owners; whatever
 * path wrote `text` (apply, restore, a recovery stop, a republish, a reload) cannot bypass it. */
export function assertSingleOwners(
  text: string,
  identity: (address: string) => string,
  outside?: { readonly sites: readonly string[]; readonly owner: string },
): void {
  const owners = new Map<
    string,
    { owner: string; address: string; token?: string }
  >();
  const claim = (address: string, owner: string, token?: string) => {
    const id = identity(address);
    const held = owners.get(id);
    if (held && held.owner !== owner)
      throw new RigError(
        "ROUTE_CONFLICT",
        `The hostname ${address} would belong to two owners: ${held.owner} and ${owner}.`,
        "Each hostname has one owner. Remove one: rig down or rig destroy the Target that should not serve it, or take it out of proxy.routes in config.yaml and run rig proxy reload. Nothing changed.",
        {
          hostname: address,
          owners: [held.owner, owner],
          // The Target blocks involved, by their markers' token, so a caller holding Target state can tell one whose
          // Target no longer exists.
          routeTokens: [held.token, token].filter(
            (value): value is string => value !== undefined,
          ),
        },
      );
    owners.set(id, { owner, address, ...(token ? { token } : {}) });
  };
  for (const match of text.matchAll(
    /# rig begin ([0-9a-f]{64})\r?\n([\s\S]*?)# rig end \1/g,
  ))
    for (const site of parseOwnedSites(match[2]!))
      claim(
        site.hostname,
        `the Target route ${match[1]!.slice(0, 12)}`,
        match[1]!,
      );
  for (const address of outside?.sites ?? []) claim(address, outside!.owner);
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
  const token = routeOwnerToken(key);
  return { begin: `# rig begin ${token}`, end: `# rig end ${token}` };
}
/** `text` without the owned blocks whose key is not in `owners`, everything else left as it is, and the hostnames those
 * blocks served. A block is matched by its markers' token, the sha256 of its key; incomplete markers are left alone. */
export function withoutUnownedBlocks(
  text: string,
  owners: ReadonlySet<string>,
): { text: string; hostnames: string[] } {
  const owned = new Set([...owners].map(routeOwnerToken));
  const hostnames: string[] = [];
  const kept = text.replace(
    /# rig begin ([0-9a-f]{64})\r?\n([\s\S]*?)# rig end \1(?:\r?\n)?/g,
    (whole, token: string, body: string) => {
      if (owned.has(token)) return whole;
      hostnames.push(...parseOwnedSites(body).map((site) => site.hostname));
      return "";
    },
  );
  return { text: kept, hostnames };
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
