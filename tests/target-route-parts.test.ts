import { expect, test } from "bun:test";
import { siteRoutes } from "../src/adapters/target-routes";
import type { TargetPlan } from "../src/config/types";

const plan = (extra: Partial<TargetPlan> = {}): TargetPlan => ({
  project: "demo",
  target: "stable",
  workspacePath: "/ws",
  dataRoot: "/data",
  deploymentName: "stable",
  branchSlug: "stable",
  subdomain: "stable",
  providers: { processSupervisor: "rigd" },
  components: [],
  preparedComponents: [],
  ...extra,
});

test("a Target's sites carry each path's upstream as given for its port", () => {
  const routed = plan({
    domain: "demo.example",
    proxy: {
      upstream: "web",
      routes: [
        { prefix: "/api", service: "api", port: 4000 },
        { prefix: "/", service: "web", port: 3000 },
      ],
    },
    serviceDomains: [{ hostname: "admin.example", service: "api", port: 4000 }],
  });
  expect(
    siteRoutes(routed, (port) => (port === 3000 ? "127.0.0.1:3000" : null)),
  ).toEqual([
    {
      hostname: "demo.example",
      routes: [
        { prefix: "/api", upstream: null },
        { prefix: "/", upstream: "127.0.0.1:3000" },
      ],
    },
    { hostname: "admin.example", routes: [{ prefix: "/", upstream: null }] },
  ]);
  expect(siteRoutes(plan(), () => "x")).toEqual([]);
});
