import { expect, test } from "bun:test";
import { plannedRoutes, plannedSites } from "../src/runtime/ports";
import type { TargetPlan } from "../src/config/types";

const web = {
  kind: "managed" as const,
  name: "web",
  command: "serve",
  port: 4100,
} as TargetPlan["components"][number];

test("a Target serves its domain as one site with its route map, and no site without a hostname or a proxy", () => {
  const routes = [
    { prefix: "/api", service: "api", port: 4200 },
    { prefix: "/", service: "web", port: 4100 },
  ];
  const plan = {
    domain: "app.test",
    proxy: { upstream: "web", routes },
    components: [web],
  };
  expect(plannedSites(plan)).toEqual([{ hostname: "app.test", routes }]);
  expect(plannedRoutes(plan)).toEqual(routes);
  expect(plannedSites({ ...plan, domain: undefined })).toEqual([]);
  expect(plannedSites({ ...plan, proxy: undefined })).toEqual([]);
});

test("a plan recorded before route maps routes '/' to its upstream's one port, and a site with no managed upstream has no routes", () => {
  const plan = {
    domain: "app.test",
    proxy: { upstream: "web" },
    components: [web],
  };
  expect(plannedSites(plan)).toEqual([
    {
      hostname: "app.test",
      routes: [{ prefix: "/", service: "web", port: 4100 }],
    },
  ]);
  // Publishing refuses such a site (ROUTE_UPSTREAM); it is still listed so the refusal names it.
  expect(plannedSites({ ...plan, proxy: { upstream: "missing" } })).toEqual([
    { hostname: "app.test", routes: [] },
  ]);
  expect(plannedRoutes({ ...plan, proxy: { upstream: "missing" } })).toEqual(
    [],
  );
});
