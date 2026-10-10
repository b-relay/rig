import { expect, test } from "bun:test";
import { configProblems } from "../src/domain/config-allowlist";

/** Shaped like `caddy adapt` of Rig's main file (checked against Caddy 2.10.2). */
const rigRoute = (host: string, dial: string) => ({
  match: [{ host: [host] }],
  handle: [
    {
      handler: "subroute",
      routes: [
        { handle: [{ handler: "reverse_proxy", upstreams: [{ dial }] }] },
      ],
    },
  ],
  terminal: true,
});
const abortRoute = {
  match: [{ host: ["*.example.test"] }],
  handle: [
    {
      handler: "subroute",
      routes: [{ handle: [{ handler: "static_response", abort: true }] }],
    },
  ],
  terminal: true,
};
function config(
  routes: unknown[],
  extra: {
    servers?: Record<string, unknown>;
    tls?: unknown;
    root?: object;
  } = {},
) {
  return {
    admin: {
      listen: "unix//r/caddy/admin.sock|0600",
      config: { persist: false },
    },
    storage: { module: "file_system", root: "/r/caddy/data" },
    ...extra.root,
    apps: {
      http: {
        http_port: 80,
        https_port: 443,
        servers: { srv0: { listen: [":443"], routes }, ...extra.servers },
      },
      tls: extra.tls ?? {
        automation: {
          policies: [
            {
              issuers: [
                {
                  module: "acme",
                  ca: "https://acme-v02.api.letsencrypt.org/directory",
                },
              ],
            },
          ],
        },
      },
    },
  };
}
const base = config([
  rigRoute("rig.example.test", "127.0.0.1:3001"),
  abortRoute,
]);
const check = (full: unknown, from: unknown = base) =>
  configProblems({
    base: from,
    full,
    hosts: ["rig.example.test", "custom.example.test", "*.example.test"],
    subjects: ["custom.example.test", "*.example.test"],
    httpsListen: [":443"],
  });
const customRoute = (handle: unknown[], host = "custom.example.test") => ({
  match: [{ host: [host] }],
  handle: [{ handler: "subroute", routes: [{ handle }] }],
  terminal: true,
});

test("custom sites may add routes for their own hostnames to loopback services, responses, headers, rewrites and encoding", () => {
  expect(
    check(
      config([
        customRoute([
          { handler: "headers", response: { set: { "X-A": ["b"] } } },
          { handler: "encode", encodings: { gzip: {} }, prefer: ["gzip"] },
          { handler: "rewrite", uri: "/v1{http.request.uri}" },
          { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:3002" }] },
        ]),
        rigRoute("rig.example.test", "127.0.0.1:3001"),
        abortRoute,
        customRoute([{ handler: "static_response", body: "ok" }]),
      ]),
    ),
  ).toEqual([]);
});

test("any other handler, a remote upstream, a placeholder that reads files, or a foreign hostname is refused at its JSON path", () => {
  const routes = (route: unknown) =>
    config([rigRoute("rig.example.test", "127.0.0.1:3001"), abortRoute, route]);
  expect(
    check(routes(customRoute([{ handler: "file_server", root: "/" }]))),
  ).toEqual([
    {
      path: "$.apps.http.servers.srv0.routes[2].handle[0].routes[0].handle[0].handler",
      problem: expect.stringContaining("file_server is not allowed"),
    },
  ]);
  expect(
    check(
      routes(
        customRoute([
          { handler: "reverse_proxy", upstreams: [{ dial: "10.0.0.5:80" }] },
        ]),
      ),
    )[0],
  ).toMatchObject({
    path: "$.apps.http.servers.srv0.routes[2].handle[0].routes[0].handle[0].upstreams[0]",
  });
  expect(
    check(
      routes(
        customRoute([
          { handler: "static_response", body: "{file./etc/passwd}" },
        ]),
      ),
    )[0],
  ).toMatchObject({ problem: expect.stringContaining("placeholder") });
  expect(
    check(
      routes(
        customRoute(
          [{ handler: "static_response", body: "x" }],
          "elsewhere.example.org",
        ),
      ),
    )[0],
  ).toMatchObject({
    path: "$.apps.http.servers.srv0.routes[2].match[0].host",
  });
  // A site route without a hostname would catch every request: a wildcard route.
  expect(
    check(routes({ handle: [{ handler: "static_response", body: "x" }] }))[0],
  ).toMatchObject({ path: "$.apps.http.servers.srv0.routes[2].match" });
});

test("certificates from files, changed TLS policies, new listeners and changed globals are refused", () => {
  // tls {$CERT_PATH} {$KEY_PATH}: Caddy adds a connection policy and loads files.
  const withFiles = config(
    [rigRoute("rig.example.test", "127.0.0.1:3001"), abortRoute],
    {
      tls: {
        automation: (base.apps.tls as { automation: unknown }).automation,
        certificates: {
          load_files: [{ certificate: "/etc/c.pem", key: "/etc/k.pem" }],
        },
      },
    },
  );
  withFiles.apps.http.servers.srv0 = {
    ...withFiles.apps.http.servers.srv0,
    tls_connection_policies: [{ match: { sni: ["custom.example.test"] } }],
  } as typeof withFiles.apps.http.servers.srv0;
  expect(check(withFiles).map((problem) => problem.path)).toEqual([
    "$.apps.tls.certificates",
    "$.apps.http.servers.srv0.tls_connection_policies",
  ]);
  // Another issuer for the same policy.
  expect(
    check(
      config([rigRoute("rig.example.test", "127.0.0.1:3001"), abortRoute], {
        tls: {
          automation: {
            policies: [{ issuers: [{ module: "internal" }] }],
          },
        },
      }),
    )[0],
  ).toMatchObject({ path: "$.apps.tls.automation.policies[0]" });
  // A server on another port (an http:// site on :28080).
  expect(
    check(
      config([rigRoute("rig.example.test", "127.0.0.1:3001"), abortRoute], {
        servers: {
          srv1: {
            listen: [":28080"],
            routes: [customRoute([{ handler: "static_response" }])],
            automatic_https: { skip: ["custom.example.test"] },
          },
        },
      }),
    )[0],
  ).toMatchObject({ path: "$.apps.http.servers.srv1.listen" });
  // admin and logging are Rig's.
  expect(
    check(
      config([rigRoute("rig.example.test", "127.0.0.1:3001"), abortRoute], {
        root: { logging: { logs: { default: { level: "DEBUG" } } } },
      }),
    ),
  ).toEqual([{ path: "$.logging", problem: "differs from what Rig sets" }]);
});

test("servers are matched by what they listen on, since Caddy renumbers them, and TLS subjects a custom host needs are allowed", () => {
  const renamed = {
    ...base,
    apps: {
      ...base.apps,
      http: {
        ...base.apps.http,
        servers: {
          srv7: {
            listen: [":443"],
            routes: [
              rigRoute("rig.example.test", "127.0.0.1:3001"),
              abortRoute,
              customRoute([{ handler: "static_response" }]),
            ],
          },
        },
      },
    },
  };
  expect(check(renamed)).toEqual([]);
  const withSubject = config(
    [rigRoute("rig.example.test", "127.0.0.1:3001"), abortRoute],
    {
      tls: {
        automation: {
          policies: [
            {
              subjects: ["custom.example.test"],
              issuers: [
                {
                  module: "acme",
                  ca: "https://acme-v02.api.letsencrypt.org/directory",
                },
              ],
            },
          ],
        },
      },
    },
  );
  expect(check(withSubject)).toEqual([]);
  const foreignSubject = structuredClone(withSubject);
  (
    foreignSubject.apps.tls as {
      automation: { policies: { subjects: string[] }[] };
    }
  ).automation.policies[0]!.subjects = ["other.example.org"];
  expect(check(foreignSubject)[0]).toMatchObject({
    path: "$.apps.tls.automation.policies[0].subjects",
  });
});

test("Rig's own routes are held to the allowlist too, so a snippet its site lines import cannot slip anything past it", () => {
  // Both configs carry it, so only the allowlist on every route can see it.
  const snippetAdded = config([
    {
      ...rigRoute("rig.example.test", "127.0.0.1:3001"),
      handle: [{ handler: "file_server", root: "/Users" }],
    },
    abortRoute,
  ]);
  expect(check(snippetAdded, snippetAdded)[0]).toMatchObject({
    path: "$.apps.http.servers.srv0.routes[0].handle[0].handler",
  });
});
