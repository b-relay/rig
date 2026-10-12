import { expect, test } from "bun:test";
import { canRunNow, runJobCommand, targetJobs } from "../web/lib/jobs";
import { commandSchema } from "../src/daemon/protocol";
import {
  managedProxyRoutes,
  ownRoutesNote,
  pendingNote,
  proxyRoutes,
  siteUrl,
} from "../web/lib/proxy";
import type { TargetReport } from "../web/lib/types";

const target = (fields: Partial<TargetReport> & Record<string, unknown> = {}) =>
  ({
    name: "stable",
    kind: "stable",
    state: "running",
    components: [],
    ...fields,
  }) as TargetReport;

test("a Target's jobs are read from its status as rigd reports them; a Target with none reports none", () => {
  expect(targetJobs(target())).toEqual([]);
  const jobs = targetJobs(
    target({
      jobs: [
        {
          name: "backup",
          schedule: "0 3 * * *",
          timeZone: "America/New_York",
          state: "idle",
          scheduled: true,
          nextRunAt: "2026-10-11T07:00:00.000Z",
          last: {
            trigger: "schedule",
            startedAt: "2026-10-10T07:00:00.000Z",
            finishedAt: "2026-10-10T07:00:42.000Z",
            durationMs: 42000,
            outcome: "succeeded",
            summary: "succeeded in 42s",
          },
        },
      ],
    }),
  );
  expect(jobs).toMatchObject([
    { name: "backup", last: { outcome: "succeeded" } },
  ]);
});

test("Run now sends rig run's command for the Target, and is offered unless a run goes or the job was removed", () => {
  expect(runJobCommand("demo", target(), "backup")).toEqual({
    action: "run",
    project: "demo",
    target: "stable",
    job: "backup",
  });
  expect(
    runJobCommand(
      "demo",
      target({ kind: "preview", name: "feat-1a2b3c4d" }),
      "backup",
    ),
  ).toEqual({
    action: "run",
    project: "demo",
    target: "preview",
    deployment: "feat-1a2b3c4d",
    job: "backup",
  });
  // The command is one the control plane accepts.
  expect(
    commandSchema.safeParse(runJobCommand("demo", target(), "backup")).success,
  ).toBe(true);
  const job = {
    name: "backup",
    schedule: "0 3 * * *",
    timeZone: "UTC",
    state: "idle" as const,
    scheduled: false,
  };
  const stable = { state: "running" as const };
  expect(canRunNow(job, stable)).toBe(true);
  expect(canRunNow({ ...job, state: "running" }, stable)).toBe(false);
  expect(canRunNow({ ...job, removed: true }, stable)).toBe(false);
  // rig run refuses a Target only rig.yaml names until it is up or deployed.
  expect(canRunNow(job, { state: "configured" })).toBe(false);
});

test("every hostname and path on the Host leads to its Target's Service, by host then longest prefix", () => {
  const routes = proxyRoutes([
    {
      project: { name: "shop", repoPath: "/s", targetCount: 1 },
      status: {
        ok: true,
        value: {
          project: "shop",
          targets: [
            target({
              route: "shop.test",
              routePublished: false,
              routes: [
                { prefix: "/", service: "web", port: 1 },
                { prefix: "/api", service: "api", port: 2 },
              ],
            }),
          ],
        },
      },
    },
    {
      project: { name: "blog", repoPath: "/b", targetCount: 1 },
      status: {
        ok: true,
        value: {
          project: "blog",
          targets: [
            target({
              name: "feat-x",
              kind: "preview",
              route: "blog-feat-x.test",
              components: [
                {
                  name: "web",
                  kind: "managed",
                  state: "stopped",
                  port: 3,
                  route: "blog-feat-x.test",
                },
              ],
              state: "stopped",
            }),
          ],
        },
      },
    },
    {
      project: { name: "gone", repoPath: "/g", targetCount: 0, missing: true },
    },
  ]);
  expect(
    routes.map((route) => [
      route.host,
      route.prefix,
      route.upstream,
      route.published,
    ]),
  ).toEqual([
    ["blog-feat-x.test", "/", "127.0.0.1:3", true],
    ["shop.test", "/api", "127.0.0.1:2", false],
    ["shop.test", "/", "127.0.0.1:1", false],
  ]);
  expect(routes[0]).toMatchObject({
    project: "blog",
    target: "feat-x",
    kind: "preview",
    state: "stopped",
  });
});

test("a Target's Service domains are listed on the proxy page beside its domain, each leading to its Service's port", () => {
  const routes = proxyRoutes([
    {
      project: { name: "melody", repoPath: "/m", targetCount: 1 },
      status: {
        ok: true,
        value: {
          project: "melody",
          targets: [
            target({
              route: "melody.test",
              hostnames: ["melody.test", "api.melody.test"],
              routes: [{ prefix: "/", service: "web", port: 1 }],
              serviceDomains: [
                { hostname: "api.melody.test", service: "api", port: 2 },
              ],
            }),
          ],
        },
      },
    },
  ]);
  expect(
    routes.map((route) => [
      route.host,
      route.prefix,
      route.service,
      route.upstream,
    ]),
  ).toEqual([
    ["api.melody.test", "/", "api", "127.0.0.1:2"],
    ["melody.test", "/", "web", "127.0.0.1:1"],
  ]);
});

test("with Rig's own Caddy, its proxy read names every hostname served, Targets' and the owner's own routes, and status adds each Service and state", () => {
  const fromStatus = proxyRoutes([
    {
      project: { name: "shop", repoPath: "/s", targetCount: 1 },
      status: {
        ok: true,
        value: {
          project: "shop",
          targets: [
            target({
              route: "shop.test",
              routes: [
                { prefix: "/", service: "web", port: 1 },
                { prefix: "/api", service: "api", port: 2 },
              ],
            }),
          ],
        },
      },
    },
  ]);
  const report = {
    caddy: {
      state: "running" as const,
      ports: { http: 80, https: 443 },
      ca: "letsencrypt",
      generation: "g001",
    },
    sites: [
      {
        hostname: "shop.test",
        source: "target" as const,
        project: "shop",
        target: "stable",
        routes: [
          { prefix: "/api", upstream: null },
          { prefix: "/", upstream: "127.0.0.1:1" },
        ],
      },
      {
        hostname: "code.test",
        source: "custom" as const,
        upstream: "127.0.0.1:8080",
      },
    ],
  };
  const routes = managedProxyRoutes(report, fromStatus);
  expect(routes).toEqual([
    {
      host: "code.test",
      url: "https://code.test/",
      prefix: "/",
      source: "custom",
      upstream: "127.0.0.1:8080",
      published: true,
    },
    expect.objectContaining({
      host: "shop.test",
      url: "https://shop.test/api",
      prefix: "/api",
      service: "api",
      state: "running",
      withheld: true,
    }),
    expect.objectContaining({
      host: "shop.test",
      prefix: "/",
      service: "web",
      upstream: "127.0.0.1:1",
    }),
  ]);
  // The path Rig withdrew has no upstream, whatever status remembers.
  expect(routes[1]).not.toHaveProperty("upstream");
});

test("dashboard links and matching use the address as Caddy does: case, an explicit scheme and port, and Caddy's HTTPS port", () => {
  const ports = { http: 28080, https: 28443 };
  expect(siteUrl("Code.Test", ports)).toBe("https://code.test:28443/");
  expect(siteUrl("https://app.test:9443", ports, "/api")).toBe(
    "https://app.test:9443/api",
  );
  expect(siteUrl("http://plain.test", ports)).toBe("http://plain.test:28080/");
  expect(siteUrl("app.test", { http: 80, https: 443 })).toBe(
    "https://app.test/",
  );
  const fromStatus = proxyRoutes([
    {
      project: { name: "shop", repoPath: "/s", targetCount: 1 },
      status: {
        ok: true,
        value: {
          project: "shop",
          targets: [
            target({
              route: "shop.test",
              routes: [{ prefix: "/", service: "web", port: 1 }],
            }),
          ],
        },
      },
    },
  ]);
  const routes = managedProxyRoutes(
    {
      caddy: { state: "running", ports, ca: "internal" },
      sites: [
        {
          hostname: "https://SHOP.test:9443",
          source: "target",
          project: "shop",
          target: "stable",
          routes: [{ prefix: "/", upstream: "127.0.0.1:1" }],
        },
        { hostname: "own.test", source: "custom", upstream: "127.0.0.1:2" },
      ],
    },
    fromStatus,
  );
  // An upper-case, explicit address still finds its Target's Service and state.
  expect(routes).toEqual([
    expect.objectContaining({
      host: "own.test:28443",
      url: "https://own.test:28443/",
    }),
    expect.objectContaining({
      host: "shop.test:9443",
      url: "https://shop.test:9443/",
      service: "web",
      state: "running",
    }),
  ]);
});

test("the owner's own routes are set in config.yaml, and need Rig's own Caddy", () => {
  expect(
    ownRoutesNote({
      ok: true,
      value: {
        caddy: {
          state: "running",
          ports: { http: 80, https: 443 },
          ca: "letsencrypt",
        },
        sites: [],
      },
    }),
  ).toContain("proxy.routes in config.yaml");
  expect(
    ownRoutesNote({
      ok: false,
      failure: { code: "PROXY_UNMANAGED", message: "no" },
    }),
  ).toContain("With a proxy section in config.yaml");
  expect(
    ownRoutesNote({
      ok: false,
      failure: { code: "DAEMON_MISSING", message: "rigd is not reachable." },
    }),
  ).toContain("rigd is not reachable.");
});

test("Host config the dashboard's Caddy does not serve is shown apart, with why", () => {
  const value = {
    caddy: {
      state: "running" as const,
      ports: { http: 80, https: 443 },
      ca: "letsencrypt",
    },
    sites: [],
  };
  expect(pendingNote({ ok: true, value })).toBeUndefined();
  expect(
    pendingNote({
      ok: true,
      value: {
        ...value,
        pending: { fields: ["routes", "tls"], reason: "Refused: a collision." },
      },
    }),
  ).toBe(
    "The proxy settings in config.yaml (routes, tls) are not served yet, so this page shows what Caddy last accepted. Refused: a collision.",
  );
  expect(
    pendingNote({
      ok: false,
      failure: { code: "PROXY_UNMANAGED", message: "" },
    }),
  ).toBeUndefined();
});
