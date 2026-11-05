import { expect, test } from "bun:test";
import type { ManagedComponent, TargetPlan } from "../src/config/types";
import { tailOf } from "../src/runtime/tail";

type Plan = Pick<
  TargetPlan,
  "domain" | "proxy" | "components" | "serviceDomains"
>;

function service(name: string, dependsOn: string[] = []): ManagedComponent {
  return {
    name,
    kind: "managed",
    command: name,
    readyTimeout: 30,
    env: {},
    dependsOn,
  };
}
/** `paths` by Service: each is served at that prefix of the Project's domain. */
function plan(
  services: ManagedComponent[],
  paths: Record<string, string> = {},
  serviceDomains: Plan["serviceDomains"] = [],
): Plan {
  return {
    ...(Object.keys(paths).length ? { domain: "app.test" } : {}),
    ...(Object.keys(paths).length
      ? {
          proxy: {
            routes: Object.entries(paths).map(([service, prefix], index) => ({
              prefix,
              service,
              port: 4000 + index,
            })),
          },
        }
      : {}),
    serviceDomains,
    components: services,
  } as Plan;
}
const names = (services: ManagedComponent[]) => services.map((s) => s.name);

const melody = [
  service("db"),
  service("api", ["db"]),
  service("web", ["api"]),
  service("search"),
];
const melodyPlan = plan(melody, { web: "/" }, [
  { hostname: "api.melody.test", service: "api", port: 4100 },
]);

test("Melody: search is the tail when it restarts, and there is none when it is kept", () => {
  expect(tailOf(melodyPlan, names(melody))).toEqual(["search"]);
  expect(tailOf(melodyPlan, ["web", "api", "db"])).toEqual([]);
});

test("Fletcher: both schedulers are the tail", () => {
  const fletcher = [
    service("comparison-refresh"),
    service("web"),
    service("google-scheduler"),
    service("points-scheduler"),
  ];
  expect(tailOf(plan(fletcher, { web: "/" }), names(fletcher))).toEqual([
    "google-scheduler",
    "points-scheduler",
  ]);
});

test("Share: explorer, which depends on the routed server, is no tail", () => {
  const share = [service("server"), service("explorer", ["server"])];
  expect(tailOf(plan(share, { server: "/" }), names(share))).toEqual([]);
});

test("a Project whose last Service has a path, and one with a single Service, have no tail", () => {
  const needed = [service("db"), service("web", ["db"])];
  expect(tailOf(plan(needed, { web: "/" }), names(needed))).toEqual([]);
  expect(tailOf(plan([service("web")], { web: "/" }), ["web"])).toEqual([]);
});

test("a Service that depends on a routed one transitively ends the tail, and so stops what is before it", () => {
  const services = [
    service("web"),
    service("early"),
    service("mid", ["web"]),
    service("worker", ["mid"]),
    service("last"),
  ];
  expect(tailOf(plan(services, { web: "/" }), names(services))).toEqual([
    "last",
  ]);
});

test("a dependency through a kept routed Service still excludes: the full plan keeps the edge", () => {
  const services = [
    service("api"),
    service("mid", ["api"]),
    service("worker", ["mid"]),
  ];
  const full = plan(services, { api: "/" });
  // api and mid are kept: the list is worker alone, and it needs a path through them.
  expect(tailOf(full, ["worker"])).toEqual([]);
  expect(tailOf(full, ["mid", "worker"])).toEqual([]);
});

test("a kept tail Service leaves the list, and what is left of the run stays the tail", () => {
  const services = [
    service("web"),
    service("first"),
    service("second"),
    service("third"),
  ];
  const full = plan(services, { web: "/" });
  expect(tailOf(full, ["web", "first", "third"])).toEqual(["first", "third"]);
  expect(tailOf(full, ["web", "first", "second"])).toEqual(["first", "second"]);
});

test("a kept routed Service is transparent: it is not in the list, so it does not end the tail", () => {
  const services = [service("first"), service("web"), service("second")];
  const full = plan(services, { web: "/" });
  expect(tailOf(full, ["first", "second"])).toEqual(["first", "second"]);
  expect(tailOf(full, ["first", "web", "second"])).toEqual(["second"]);
});

test("a Service with only a Service domain, and one with only a proxy path, each end the tail", () => {
  const services = [service("routed"), service("worker")];
  const byDomain = plan(services, {}, [
    { hostname: "routed.test", service: "routed", port: 4200 },
  ]);
  expect(tailOf(byDomain, names(services))).toEqual(["worker"]);
  expect(tailOf(byDomain, ["routed"])).toEqual([]);
  const byPath = plan(services, { routed: "/admin" });
  expect(tailOf(byPath, names(services))).toEqual(["worker"]);
  expect(tailOf(byPath, ["routed"])).toEqual([]);
  const reversed = [service("worker"), service("routed")];
  expect(tailOf(plan(reversed, { routed: "/admin" }), names(reversed))).toEqual(
    [],
  );
});

test("a plan with no paths has no tail, whatever the list", () => {
  const services = [service("a"), service("b")];
  expect(tailOf(plan(services), names(services))).toEqual([]);
  expect(tailOf(plan(services), [])).toEqual([]);
});

test("the list follows plan order, not the order the names came in, and names no Service of the plan are ignored", () => {
  const services = [service("web"), service("a"), service("b")];
  const full = plan(services, { web: "/" });
  expect(tailOf(full, ["b", "ghost", "a", "web"])).toEqual(["a", "b"]);
});
