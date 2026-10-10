/** The structural allowlist on Caddy's adapted JSON (ADR 0014): the one authority on what the owner's custom sites, and the
 * snippets Rig's own sites import, may add to what Rig renders. Text checks on the Caddyfile only give earlier errors. */
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
  /** `caddy adapt` of Rig's main file with Rig's routes alone: no custom sites, no `site` lines. */
  readonly base: unknown;
  /** `caddy adapt` of the generation's main file: Rig's routes with their `site` lines, and the custom sites. */
  readonly full: unknown;
  /** Every host a route may match: Rig's hostnames, the custom hostnames, and Rig's wildcard parents. */
  readonly hosts: readonly string[];
  /** TLS automation subjects a custom site may add: its hostnames and the wildcards Rig would derive for them. */
  readonly subjects: readonly string[];
  /** The one listener a server may have that Rig's base does not: Rig's HTTPS port, for a Host serving only custom sites. */
  readonly httpsListen: readonly string[];
}
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
/** Request matchers a nested route may use. Hosts are checked against the allowed hosts; `expression` (CEL) is not allowed. */
const MATCHERS = new Set([
  "host",
  "path",
  "path_regexp",
  "method",
  "header",
  "header_regexp",
  "query",
  "not",
]);

/** Everything the full config does that the allowlist refuses; empty when it only adds what is allowed. */
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
  for (const key of union(baseApps, fullApps)) {
    if (key === "http") continue;
    if (key === "tls") {
      checkTls(baseApps.tls, fullApps.tls, new Set(input.subjects), refuse);
      continue;
    }
    if (!Bun.deepEquals(baseApps[key], fullApps[key]))
      refuse(`$.apps.${key}`, "is not an app custom sites may add or change");
  }
  const baseHttp = record(baseApps.http);
  const fullHttp = record(fullApps.http);
  for (const key of union(baseHttp, fullHttp))
    if (key !== "servers" && !Bun.deepEquals(baseHttp[key], fullHttp[key]))
      refuse(`$.apps.http.${key}`, "differs from what Rig sets");

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
    if (matched) {
      seen.add(listenKey(server));
      for (const key of union(matched, server))
        if (
          key !== "routes" &&
          key !== "errors" &&
          !Bun.deepEquals(matched[key], server[key])
        )
          refuse(`${path}.${key}`, "differs from what Rig sets");
    } else if (listenKey(server) !== listenKey({ listen: input.httpsListen }))
      refuse(
        `${path}.listen`,
        `adds a server listening on ${list(server.listen).join(", ")}; custom sites are served on Rig's HTTPS port only`,
      );
    else
      for (const key of Object.keys(server))
        if (!["listen", "routes", "errors"].includes(key))
          refuse(
            `${path}.${key}`,
            "is not a server setting custom sites may set",
          );
    list(server.routes).forEach((route, index) =>
      checkRoute(route, `${path}.routes[${index}]`, hosts, true, refuse),
    );
    for (const key of Object.keys(record(server.errors)))
      if (key !== "routes")
        refuse(
          `${path}.errors.${key}`,
          "is not an error setting custom sites may set",
        );
    list(record(server.errors).routes).forEach((route, index) =>
      checkRoute(route, `${path}.errors.routes[${index}]`, hosts, true, refuse),
    );
  }
  for (const key of baseServers.keys())
    if (!seen.has(key))
      refuse("$.apps.http.servers", `drops Rig's server listening on ${key}`);
  return problems;
}
/** The TLS app must be Rig's, except for automation subjects a custom site may add. */
function checkTls(
  base: unknown,
  full: unknown,
  allowed: ReadonlySet<string>,
  refuse: (path: string, problem: string) => void,
): void {
  const baseTls = record(base);
  const fullTls = record(full);
  for (const key of union(baseTls, fullTls)) {
    if (key === "automation") continue;
    if (!Bun.deepEquals(baseTls[key], fullTls[key]))
      refuse(`$.apps.tls.${key}`, "differs from what Rig sets");
  }
  const baseAutomation = record(baseTls.automation);
  const fullAutomation = record(fullTls.automation);
  for (const key of union(baseAutomation, fullAutomation))
    if (
      key !== "policies" &&
      !Bun.deepEquals(baseAutomation[key], fullAutomation[key])
    )
      refuse(`$.apps.tls.automation.${key}`, "differs from what Rig sets");
  const basePolicies = list(baseAutomation.policies);
  const fullPolicies = list(fullAutomation.policies);
  if (basePolicies.length !== fullPolicies.length) {
    refuse(
      "$.apps.tls.automation.policies",
      "adds or drops a certificate policy",
    );
    return;
  }
  fullPolicies.forEach((policy, index) => {
    const before = record(basePolicies[index]);
    const after = record(policy);
    const added = list(after.subjects)
      .map(String)
      .filter(
        (subject) => !list(before.subjects).map(String).includes(subject),
      );
    const path = `$.apps.tls.automation.policies[${index}]`;
    for (const subject of added)
      if (!allowed.has(subject.toLowerCase()))
        refuse(
          `${path}.subjects`,
          `adds ${subject}, which Rig would not manage`,
        );
    const { subjects: _, ...rest } = after;
    const { subjects: __, ...expected } = before;
    if (!Bun.deepEquals(rest, expected))
      refuse(path, "changes how certificates are issued");
  });
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
      refuse(`${path}.${key}`, "is not a route field custom sites may use");
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
  list(route.match).forEach((set, index) => {
    const matcher = record(set);
    for (const [name, argument] of Object.entries(matcher)) {
      const at = `${path}.match[${index}].${name}`;
      if (top ? name !== "host" : !MATCHERS.has(name))
        refuse(
          at,
          `is not an allowed matcher${top ? "; a site matches its hostname only" : ""}`,
        );
      if (name === "host")
        for (const host of list(argument).map(String))
          if (!hosts.has(host.toLowerCase()))
            refuse(
              at,
              `matches ${host}, which is not a hostname Rig or the custom sites serve`,
            );
      if (name === "not")
        list(argument).forEach((inner, position) =>
          checkMatcherSet(inner, `${at}[${position}]`, hosts, refuse),
        );
    }
  });
  list(route.handle).forEach((handler, index) =>
    checkHandler(handler, `${path}.handle[${index}]`, hosts, refuse),
  );
}
function checkMatcherSet(
  value: unknown,
  path: string,
  hosts: ReadonlySet<string>,
  refuse: (path: string, problem: string) => void,
): void {
  for (const [name, argument] of Object.entries(record(value))) {
    if (!MATCHERS.has(name))
      refuse(`${path}.${name}`, "is not an allowed matcher");
    if (name === "host")
      for (const host of list(argument).map(String))
        if (!hosts.has(host.toLowerCase()))
          refuse(
            `${path}.${name}`,
            `matches ${host}, which is not a hostname Rig or the custom sites serve`,
          );
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
      `${name || "a handler"} is not allowed; custom sites may use reverse_proxy to loopback, respond, header, rewrite, encode and handle`,
    );
    return;
  }
  for (const key of Object.keys(handler))
    if (!fields.has(key))
      refuse(`${path}.${key}`, `is not a ${name} field custom sites may set`);
  // A placeholder that reads a file or the environment would make a response depend on something outside the generation.
  const text = JSON.stringify(handler);
  if (/\{(?:file|env)\./.test(text))
    refuse(path, "reads a file or the environment through a placeholder");
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
