/** The structural allowlist on Caddy's adapted JSON (ADR 0014). Rig renders every generation itself, but the Host's
 * `proxy.site` lines are Caddy directives placed inside Rig's site blocks, so a generation is held to what Rig's routes
 * without them would be: only its HTTP routes may differ, and every route may only match requests by allowed matchers and
 * handle them with allowed handlers, reading nothing but the request. */
type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** One thing in the adapted config that the allowlist refuses, at its JSON path. */
export interface ConfigProblem {
  readonly path: string;
  readonly problem: string;
}
export interface AllowlistInput {
  /** `caddy adapt` of the generation's main file with Rig's routes rendered without `site` lines. */
  readonly base: unknown;
  /** `caddy adapt` of the generation's main file: what Caddy will run. */
  readonly full: unknown;
  /** Every host a route may match: the hostnames served and Rig's wildcard parents. */
  readonly hosts: readonly string[];
}
/** Placeholders a route may use: each reads the request being handled or the proxy's answer to it. `{system.*}`,
 * `{env.*}`, `{file.*}`, `{time.*}`, `{http.vars.*}` and every other kind read state outside the request. */
const PLACEHOLDERS = [
  "http.request.",
  "http.error.",
  "http.regexp.",
  "http.reverse_proxy.",
];
const LOOPBACK_DIAL = /^(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
/** Handlers a route may use, each with the fields it may set. */
const HANDLERS: Record<string, ReadonlySet<string>> = {
  reverse_proxy: new Set(["handler", "upstreams", "headers"]),
  static_response: new Set([
    "handler",
    "status_code",
    "body",
    "headers",
    "close",
    "abort",
  ]),
  headers: new Set(["handler", "request", "response"]),
  rewrite: new Set([
    "handler",
    "uri",
    "method",
    "strip_path_prefix",
    "strip_path_suffix",
    "uri_substring",
    "path_regexp",
  ]),
  encode: new Set(["handler", "encodings", "prefer", "minimum_length"]),
  subroute: new Set(["handler", "routes", "errors"]),
};
/** Request matchers a nested route may use, at any depth inside `not`: each reads only the request. Hosts are checked
 * against the allowed hosts. Everything else is refused: `file` and `vars*` read state outside the request, `remote_ip` and
 * `client_ip` are not needed by a site that only serves loopback, and `expression` (CEL) can call any of them. */
const MATCHERS = new Set([
  "host",
  "path",
  "path_regexp",
  "method",
  "header",
  "header_regexp",
  "query",
  "protocol",
  "not",
]);

/** Everything the full config does that the allowlist refuses; empty when it differs from the base only by allowed routes. */
export function configProblems(input: AllowlistInput): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const refuse = (path: string, problem: string) =>
    problems.push({ path, problem });
  const base = record(input.base);
  const full = record(input.full);
  const hosts = new Set(input.hosts.map((host) => host.toLowerCase()));

  for (const key of union(base, full))
    if (key !== "apps" && !Bun.deepEquals(base[key], full[key]))
      refuse(`$.${key}`, "differs from what Rig sets");
  const baseApps = record(base.apps);
  const fullApps = record(full.apps);
  for (const key of union(baseApps, fullApps))
    if (key !== "http" && !Bun.deepEquals(baseApps[key], fullApps[key]))
      refuse(`$.apps.${key}`, "differs from what Rig sets");
  const baseHttp = record(baseApps.http);
  const fullHttp = record(fullApps.http);
  for (const key of union(baseHttp, fullHttp))
    if (key !== "servers" && !Bun.deepEquals(baseHttp[key], fullHttp[key]))
      refuse(`$.apps.http.${key}`, "differs from what Rig sets");

  // Caddy names servers srv0, srv1... in an order of its own, so they are matched by what they listen on.
  const listenKey = (server: unknown) =>
    JSON.stringify(list(record(server).listen).map(String).sort());
  const baseServers = new Map(
    Object.values(record(baseHttp.servers)).map((server) => [
      listenKey(server),
      record(server),
    ]),
  );
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(record(fullHttp.servers))) {
    const server = record(value);
    const path = `$.apps.http.servers.${name}`;
    const matched = baseServers.get(listenKey(server));
    if (!matched) {
      refuse(
        `${path}.listen`,
        `adds a server listening on ${list(server.listen).join(", ")}`,
      );
      continue;
    }
    seen.add(listenKey(server));
    for (const key of union(matched, server))
      if (
        key !== "routes" &&
        key !== "errors" &&
        !Bun.deepEquals(matched[key], server[key])
      )
        refuse(`${path}.${key}`, "differs from what Rig sets");
    list(server.routes).forEach((route, index) =>
      checkRoute(route, `${path}.routes[${index}]`, hosts, true, refuse),
    );
    for (const key of Object.keys(record(server.errors)))
      if (key !== "routes")
        refuse(`${path}.errors.${key}`, "is not an allowed error setting");
    list(record(server.errors).routes).forEach((route, index) =>
      checkRoute(route, `${path}.errors.routes[${index}]`, hosts, true, refuse),
    );
  }
  for (const key of baseServers.keys())
    if (!seen.has(key))
      refuse("$.apps.http.servers", `drops Rig's server listening on ${key}`);
  return problems;
}
function checkRoute(
  value: unknown,
  path: string,
  hosts: ReadonlySet<string>,
  top: boolean,
  refuse: (path: string, problem: string) => void,
): void {
  const route = record(value);
  for (const key of Object.keys(route))
    if (!["match", "handle", "terminal", "group"].includes(key))
      refuse(`${path}.${key}`, "is not an allowed route field");
  // A site route that matches no hostname would catch every request on the port: a wildcard route, which Rig never serves.
  if (
    top &&
    (list(route.match).length === 0 ||
      list(route.match).some((set) => list(record(set).host).length === 0))
  )
    refuse(
      `${path}.match`,
      "matches no hostname; a site must name the hostnames it serves",
    );
  // A placeholder that reads anything but the request would make a response, or a match, depend on state outside the
  // generation: the machine, the environment, a file or a variable another handler set.
  if (top)
    for (const [, name] of JSON.stringify(route).matchAll(
      /\{([A-Za-z_$][^{}\s"]*)\}/g,
    ))
      if (!PLACEHOLDERS.some((prefix) => name!.startsWith(prefix)))
        refuse(
          path,
          `uses the placeholder {${name}}, which reads more than the request`,
        );
  list(route.match).forEach((set, index) =>
    checkMatcherSet(set, `${path}.match[${index}]`, hosts, top, refuse),
  );
  list(route.handle).forEach((handler, index) =>
    checkHandler(handler, `${path}.handle[${index}]`, hosts, refuse),
  );
}
/** One matcher set, and every set inside its `not`, to any depth. A site route's own sets match by hostname only. */
function checkMatcherSet(
  value: unknown,
  path: string,
  hosts: ReadonlySet<string>,
  top: boolean,
  refuse: (path: string, problem: string) => void,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse(path, "is not a matcher set");
    return;
  }
  for (const [name, argument] of Object.entries(record(value))) {
    const at = `${path}.${name}`;
    if (top ? name !== "host" : !MATCHERS.has(name)) {
      refuse(
        at,
        `is not an allowed matcher${top ? "; a site matches its hostname only" : ""}`,
      );
      continue;
    }
    if (name === "host")
      for (const host of list(argument).map(String))
        if (!hosts.has(host.toLowerCase()))
          refuse(at, `matches ${host}, which is not a hostname Rig serves`);
    if (name === "not") {
      if (!Array.isArray(argument)) refuse(at, "is not a list of matcher sets");
      list(argument).forEach((inner, position) =>
        checkMatcherSet(inner, `${at}[${position}]`, hosts, false, refuse),
      );
    }
  }
}
function checkHandler(
  value: unknown,
  path: string,
  hosts: ReadonlySet<string>,
  refuse: (path: string, problem: string) => void,
): void {
  const handler = record(value);
  const name = String(handler.handler ?? "");
  const fields = HANDLERS[name];
  if (!fields) {
    refuse(
      `${path}.handler`,
      `${name || "a handler"} is not allowed; routes may use reverse_proxy to loopback, respond, header, rewrite, encode and handle`,
    );
    return;
  }
  for (const key of Object.keys(handler))
    if (!fields.has(key))
      refuse(`${path}.${key}`, `is not an allowed ${name} field`);
  if (name === "reverse_proxy")
    list(handler.upstreams).forEach((upstream, index) => {
      const entry = record(upstream);
      if (
        Object.keys(entry).some((key) => key !== "dial") ||
        !LOOPBACK_DIAL.test(String(entry.dial ?? ""))
      )
        refuse(
          `${path}.upstreams[${index}]`,
          "is not a loopback upstream (127.0.0.1, localhost or [::1] with a port)",
        );
    });
  if (name === "encode")
    for (const encoding of Object.keys(record(handler.encodings)))
      if (!["gzip", "zstd"].includes(encoding))
        refuse(`${path}.encodings.${encoding}`, "is not an allowed encoding");
  if (name === "subroute") {
    list(handler.routes).forEach((route, index) =>
      checkRoute(route, `${path}.routes[${index}]`, hosts, false, refuse),
    );
    list(record(handler.errors).routes).forEach((route, index) =>
      checkRoute(
        route,
        `${path}.errors.routes[${index}]`,
        hosts,
        false,
        refuse,
      ),
    );
  }
}
function union(a: Json, b: Json): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}
