import { expect, test } from "bun:test";
import { canRunNow, runJobCommand, targetJobs } from "../web/lib/jobs";
import { commandSchema } from "../src/daemon/protocol";
import {
  customCaddyFile,
  managedProxyRoutes,
  proxyRoutes,
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
  expect(canRunNow(job)).toBe(true);
  expect(canRunNow({ ...job, state: "running" })).toBe(false);
  expect(canRunNow({ ...job, removed: true })).toBe(false);
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

test("with Rig's own Caddy, its proxy read names every hostname served, Rig's and custom, and status adds each Service and state", () => {
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
      { hostname: "code.test", source: "custom" as const },
    ],
    custom: [
      {
        file: "/r/proxy/custom.caddy",
        state: "pending" as const,
        text: "code.test {\n\trespond ok\n}\n",
      },
    ],
  };
  expect(managedProxyRoutes(report, fromStatus)).toEqual([
    {
      host: "code.test",
      url: "https://code.test/",
      prefix: "/",
      source: "custom",
      published: true,
    },
    expect.objectContaining({
      host: "shop.test",
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
  expect(managedProxyRoutes(report, fromStatus)[1]).not.toHaveProperty(
    "upstream",
  );
  expect(customCaddyFile({ ok: true, value: report })).toEqual({
    supported: true,
    path: "/r/proxy/custom.caddy",
    state: "pending",
    text: "code.test {\n\trespond ok\n}\n",
  });
});

test("without Rig's own Caddy, the custom file says why it is not there", () => {
  expect(
    customCaddyFile({
      ok: false,
      failure: { code: "PROXY_UNMANAGED", message: "no" },
    }),
  ).toMatchObject({
    supported: false,
    reason: expect.stringContaining("proxy section"),
  });
  expect(
    customCaddyFile({
      ok: false,
      failure: { code: "DAEMON_MISSING", message: "rigd is not reachable." },
    }),
  ).toMatchObject({
    supported: false,
    reason: expect.stringContaining("rigd is not reachable."),
  });
});
