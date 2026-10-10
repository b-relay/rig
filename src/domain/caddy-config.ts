/** Reading Caddy's JSON configuration, as `caddy adapt` produces it and as GET /config/ on the admin socket returns it; the
 * two are equal for the same Caddyfile (checked on 2.10.2), which is how Rig knows what a running Caddy serves. */
type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Every site address the config's HTTP servers match on, from the host matchers of their top-level routes. A server that
 * listens only on the plain HTTP port serves its hosts without TLS, so they are given as `http://<host>`. */
export function adaptedSiteAddresses(config: unknown, httpPort = 80): string[] {
  const servers = record(record(record(config).apps).http).servers;
  const addresses: string[] = [];
  for (const server of Object.values(record(servers))) {
    const listen = list(record(server).listen).map(String);
    const plain =
      listen.length > 0 &&
      listen.every((address) => address.endsWith(`:${httpPort}`));
    for (const route of list(record(server).routes))
      for (const match of list(record(route).match))
        for (const host of list(record(match).host))
          addresses.push(plain ? `http://${String(host)}` : String(host));
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
