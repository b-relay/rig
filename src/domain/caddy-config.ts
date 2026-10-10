/** Reading Caddy's JSON configuration, as `caddy adapt` produces it and as GET /config/ on the admin socket returns it; the
 * two are equal for the same Caddyfile (checked on 2.10.2), which is how Rig knows what a running Caddy serves. */
type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Every site address the config's HTTP servers match on, from the host matchers of their top-level routes. A host is served
 * without TLS, and given as `http://<host>`, when its server's automatic HTTPS skips it or is disabled, or when the server
 * listens only on the config's own HTTP port: what Caddy itself decides from, not an assumed port 80. */
export function adaptedSiteAddresses(config: unknown): string[] {
  const http = record(record(record(config).apps).http);
  const httpPort = Number(http.http_port ?? 80);
  const addresses: string[] = [];
  for (const server of Object.values(record(http.servers))) {
    const automatic = record(record(server).automatic_https);
    const skipped = new Set(list(automatic.skip).map(String));
    const listen = list(record(server).listen).map(String);
    const plainServer =
      automatic.disable === true ||
      (listen.length > 0 &&
        listen.every((address) => address.endsWith(`:${httpPort}`)));
    for (const route of list(record(server).routes))
      for (const match of list(record(route).match))
        for (const host of list(record(match).host))
          addresses.push(
            plainServer || skipped.has(String(host))
              ? `http://${String(host)}`
              : String(host),
          );
  }
  return [...new Set(addresses)];
}
/** What Rig sets in every generation and the owner's files must not change: the admin endpoint, the storage, and the HTTP
 * and HTTPS ports. */
export interface ProtectedSettings {
  readonly admin: string;
  readonly storage: string;
  readonly httpPort: number;
  readonly httpsPort: number;
}
/** The protected settings an adapted config holds differently from `expected`, by name. */
export function protectedDifferences(
  config: unknown,
  expected: ProtectedSettings,
): string[] {
  const root = record(config);
  const http = record(record(root.apps).http);
  const differences: string[] = [];
  if (record(root.admin).listen !== expected.admin) differences.push("admin");
  const storage = record(root.storage);
  if (storage.module !== "file_system" || storage.root !== expected.storage)
    differences.push("storage");
  // With no site there is no HTTP app and nothing listens; a port left out is Caddy's default.
  if (record(root.apps).http !== undefined) {
    if ((http.http_port ?? 80) !== expected.httpPort)
      differences.push("http_port");
    if ((http.https_port ?? 443) !== expected.httpsPort)
      differences.push("https_port");
  }
  return differences;
}
/** The config's certificate assignments, canonical: each automation policy's subjects (sorted) with its issuers in order
 * (module and CA). Two configs that issue any subject from a different CA differ here, even when the set of CAs is the same,
 * so Rig restarts Caddy, whose cache would otherwise keep the certificates the old assignment issued. */
export function issuancePolicies(config: unknown): string {
  const policies = list(
    record(record(record(record(config).apps).tls).automation).policies,
  ).map((policy) => ({
    subjects: list(record(policy).subjects).map(String).sort(),
    issuers: list(record(policy).issuers).map((issuer) => {
      const entry = record(issuer);
      return [String(entry.module ?? ""), String(entry.ca ?? "")];
    }),
  }));
  return JSON.stringify(
    policies.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}
/** The CAs the config's certificate automation uses, sorted: each ACME issuer's directory, and `internal` for Caddy's own CA.
 * A change of CA needs a restart, because a reload keeps the certificates Caddy has cached. */
export function issuerCas(config: unknown): string[] {
  const policies = list(
    record(record(record(record(config).apps).tls).automation).policies,
  );
  const cas = new Set<string>();
  for (const policy of policies)
    for (const issuer of list(record(policy).issuers)) {
      const entry = record(issuer);
      cas.add(
        entry.module === "internal" ? "internal" : String(entry.ca ?? "acme"),
      );
    }
  return [...cas].sort();
}
