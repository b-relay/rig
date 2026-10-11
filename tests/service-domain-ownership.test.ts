import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { parseProjectConfig, resolveTargetPlan } from "../src/config/index.js";
import { plannedSites } from "../src/runtime/ports";
import type { RouteRequest } from "../src/providers/caddy-router";
import { managedCaddyWorld } from "./support/managed-caddy-double";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function world(...args: Parameters<typeof managedCaddyWorld>) {
  const made = await managedCaddyWorld(...args);
  roots.push(made.root);
  return made;
}

/** The stable Target of a Project whose web serves the domain and api a Service domain, as the route request target
 * effects publish for it: every site plannedSites lists, with each route's loopback upstream. */
function melodyRoute(key = "melody"): RouteRequest {
  const plan = resolveTargetPlan(
    {
      config: parseProjectConfig({
        name: "melody",
        domain: "melody.example.test",
        proxy: { "/": "web" },
        services: {
          web: { command: "web", ports: { http: "auto" } },
          api: {
            command: "api",
            ports: { http: "auto" },
            domain: "api.melody.example.test",
          },
        },
        targets: { stable: true },
      }),
      target: "stable",
      workspacePath: "/work",
      dataRoot: "/data",
      assignedPorts: { "web.http": 4100, "api.http": 4200 },
    },
    { operatorHome: "/home/operator", envRoot: "/rig/env" },
  );
  return {
    key,
    sites: plannedSites(plan).map((site) => ({
      hostname: site.hostname,
      routes: site.routes.map((route) => ({
        prefix: route.prefix,
        upstream: `127.0.0.1:${route.port}`,
      })),
    })),
  };
}

test("a Target's Service domain is published in its one block beside its domain, and withdrawn with it", async () => {
  const w = await world();
  await w.caddy.router.apply(melodyRoute());
  const routes = await w.routes();
  expect(routes).toContain(
    "melody.example.test {\n  reverse_proxy 127.0.0.1:4100\n}\n",
  );
  expect(routes).toContain(
    "api.melody.example.test {\n  reverse_proxy 127.0.0.1:4200\n}\n",
  );
  expect(routes.match(/# rig begin /g)).toHaveLength(1);
  await w.caddy.router.remove("melody");
  expect(await w.routes()).not.toContain("melody.example.test");
});

test("a Service domain proxy.routes holds is refused as the owner's, and nothing of the Target is published", async () => {
  const w = await world({ routes: { "api.melody.example.test": 3005 } });
  await expect(w.caddy.router.check!(melodyRoute())).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    details: { owner: "proxy.routes in Host config" },
  });
  await expect(w.caddy.router.apply(melodyRoute())).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    details: { owner: "proxy.routes in Host config" },
  });
  // The Target's domain, which nobody else holds, is not published alone: its hostnames go together or not at all.
  expect(await w.routes()).not.toContain("melody.example.test {");
});

test("a Service domain another Target serves is refused, whatever its case, and that Target keeps it", async () => {
  const w = await world();
  await w.caddy.router.apply({
    key: "other",
    sites: [
      {
        hostname: "Api.Melody.example.test",
        routes: [{ prefix: "/", upstream: "127.0.0.1:3009" }],
      },
    ],
  });
  const served = await w.current();
  await expect(w.caddy.router.check!(melodyRoute())).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
  });
  await expect(w.caddy.router.apply(melodyRoute())).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
  });
  expect(await w.current()).toBe(served);
  expect(await w.routes()).toContain("127.0.0.1:3009");
  expect(await w.routes()).not.toContain("127.0.0.1:4200");
});

test("an owner route added for a hostname a Service domain serves is refused and changes nothing", async () => {
  const w = await world();
  await w.caddy.router.apply(melodyRoute());
  const served = await w.current();
  w.setSettings({ routes: { "api.melody.example.test": 3005 } });
  await expect(w.caddy.republish()).rejects.toMatchObject({
    code: "ROUTE_CONFLICT",
    message: expect.stringContaining(
      "api.melody.example.test would belong to two owners",
    ),
  });
  expect(await w.current()).toBe(served);
});
