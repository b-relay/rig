import { expect, test } from "bun:test";
import { RUN_JOB_SUPPORTED, runJobCommand, targetJobs } from "../web/lib/jobs";
import { customCaddyFile, proxyRoutes } from "../web/lib/proxy";
import type { TargetReport } from "../web/lib/types";

const target = (fields: Partial<TargetReport> & Record<string, unknown> = {}) =>
  ({
    name: "stable",
    kind: "stable",
    state: "running",
    components: [],
    ...fields,
  }) as TargetReport;

test("a status without jobs comes from a rigd without scheduled jobs; a well-formed list is read as the jobs branch reports it", () => {
  expect(targetJobs(target())).toEqual({ supported: false });
  expect(targetJobs(target({ jobs: [{ name: 1 }] }))).toEqual({
    supported: false,
  });
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
  expect(jobs).toMatchObject({
    supported: true,
    jobs: [{ name: "backup", last: { outcome: "succeeded" } }],
  });
});

test("running a job now waits for rigd to accept it", () => {
  expect(RUN_JOB_SUPPORTED).toBe(false);
  expect(runJobCommand("demo", target(), "backup")).toBeUndefined();
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

test("the custom Caddy file waits for a Rig-owned Caddy", async () => {
  expect(await customCaddyFile()).toMatchObject({ supported: false });
});
