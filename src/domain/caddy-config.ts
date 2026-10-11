/** Reading Caddy's JSON configuration, as `caddy adapt` produces it and as GET /config/ on the admin socket returns it; the
 * two are equal for the same Caddyfile (checked on 2.10.2), which is how Rig knows what a running Caddy serves. */
type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

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

/** What Rig serves for an error Caddy itself raises for a site (its upstream cannot be reached or does not answer in time):
 * one line of plain text naming the status and the hostname. */
export const DOWN_PAGE_BODY =
  "{http.error.status_code} - {http.request.host} is currently down";
const DOWN_STATUSES = [502, 503, 504];
/** `config` with Rig's page on every HTTP server for errors Caddy itself raises, 502, 503 and 504 (an upstream it cannot
 * reach or that does not answer in time), answered with `DOWN_PAGE_BODY` as plain text, and Rig's own `respond 503` for a
 * withheld path saying the same. A response an app sends is not an error to Caddy: whatever its status, it passes through
 * unchanged (an app may answer 503 on purpose). Pure; Rig generates this JSON itself rather than take it from any config. */
export function withDownPages(config: unknown): unknown {
  const copy = structuredClone(config) as Json;
  const http = record(record(copy.apps).http);
  const plain = { "Content-Type": ["text/plain; charset=utf-8"] };
  const withheld = (handler: Json) =>
    handler.handler === "static_response" &&
    Number(handler.status_code) === 503 &&
    handler.body === undefined;
  const visit = (routes: unknown) => {
    for (const route of list(routes))
      for (const handler of list(record(route).handle).map(record)) {
        if (withheld(handler)) {
          handler.headers = plain;
          handler.body = "503 - {http.request.host} is currently down";
        }
        visit(handler.routes);
      }
  };
  for (const server of Object.values(record(http.servers)).map(record)) {
    visit(server.routes);
    server.errors = {
      routes: [
        {
          match: [
            {
              expression: `{http.error.status_code} in [${DOWN_STATUSES.join(", ")}]`,
            },
          ],
          handle: [
            {
              handler: "static_response",
              status_code: "{http.error.status_code}",
              headers: plain,
              body: DOWN_PAGE_BODY,
            },
          ],
          terminal: true,
        },
      ],
    };
  }
  return copy;
}
