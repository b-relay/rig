import { expect, test } from "bun:test";
import { parseProjectConfig } from "../src/config";
import { patchedSettings } from "../src/config/schema";
import {
  configuredComponents,
  configuredHostnames,
  configuredJobs,
  configuredRoutes,
  configuredTarget,
  serviceRoutes,
  unrecordedReport,
} from "../src/runtime/configured-target";

const UTC = { timeZone: () => "UTC" };
const config = parseProjectConfig({
  name: "app",
  domain: "${rig.target}.app.example.test",
  proxy: { "/": "${services.web.ports.http}" },
  services: {
    web: { command: "web", ports: { http: 4100, admin: 4101 } },
    api: {
      command: "api",
      ports: { http: 4200 },
      domain: "api.${rig.target}.app.example.test",
    },
    worker: { command: "worker" },
  },
  tools: { cli: { bin: "bin/cli" } },
  jobs: {
    nightly: {
      command: "echo nightly",
      schedule: "0 5 * * *",
      targets: ["working"],
      timezone: "Europe/London",
      timeout: "10m",
    },
    backup: {
      command: "echo backup",
      schedule: "*/15 * * * *",
      backup: { keep: 3, restore: "echo restore" },
    },
  },
  targets: { working: true, stable: true },
});

test("configuredRoutes names the role's domain, the Service its '/' reaches and each Service's own hostname", () => {
  expect(
    configuredRoutes(config, "stable", patchedSettings(config, "stable")),
  ).toEqual({
    domain: "stable.app.example.test",
    upstream: "web",
    own: [{ service: "api", hostname: "api.stable.app.example.test" }],
  });
  const undomained = parseProjectConfig({
    name: "app",
    services: { web: { command: "web", ports: { http: 4100 } } },
  });
  expect(
    configuredRoutes(
      undomained,
      "stable",
      patchedSettings(undomained, "stable"),
    ),
  ).toEqual({ own: [] });
});

test("configuredHostnames lists the domain only while '/' reaches a Service, then each Service's own, each once", () => {
  const own = [{ service: "api", hostname: "api.app.test" }];
  expect(
    configuredHostnames({ domain: "app.test", upstream: "web", own }),
  ).toEqual(["app.test", "api.app.test"]);
  expect(configuredHostnames({ domain: "app.test", own })).toEqual([
    "api.app.test",
  ]);
  expect(
    configuredHostnames({
      domain: "app.test",
      upstream: "api",
      own: [{ service: "api", hostname: "app.test" }],
    }),
  ).toEqual(["app.test"]);
});

test("serviceRoutes lists the hostnames that reach one Service, the domain first", () => {
  const routes = {
    domain: "app.test",
    upstream: "web",
    own: [
      { service: "web", hostname: "www.app.test" },
      { service: "web", hostname: "app.test" },
      { service: "api", hostname: "api.app.test" },
    ],
  };
  expect(serviceRoutes(routes, "web")).toEqual(["app.test", "www.app.test"]);
  expect(serviceRoutes(routes, "api")).toEqual(["api.app.test"]);
  expect(serviceRoutes(routes, "worker")).toEqual([]);
  expect(serviceRoutes({ upstream: "web", own: [] }, "web")).toEqual([]);
});

test("configuredComponents lists the Services, each with its first port and its hostnames, then the Tools", () => {
  const settings = patchedSettings(config, "stable");
  expect(
    configuredComponents(
      settings,
      configuredRoutes(config, "stable", settings),
    ),
  ).toEqual([
    {
      name: "web",
      kind: "managed",
      state: "configured",
      port: 4100,
      route: "stable.app.example.test",
      hostnames: ["stable.app.example.test"],
    },
    {
      name: "api",
      kind: "managed",
      state: "configured",
      port: 4200,
      route: "api.stable.app.example.test",
      hostnames: ["api.stable.app.example.test"],
    },
    { name: "worker", kind: "managed", state: "configured" },
    { name: "cli", kind: "installed", state: "configured" },
  ]);
});

test("configuredJobs lists the jobs by name, unscheduled, saying whether the role's schedule would run each", () => {
  const settings = patchedSettings(config, "stable");
  expect(configuredJobs(settings, "stable", UTC)).toEqual([
    {
      name: "backup",
      schedule: "*/15 * * * *",
      timeZone: "UTC",
      state: "idle",
      scheduled: false,
      reason:
        "stable is not deployed yet, so its jobs are not scheduled; rig deploy schedules them.",
      backup: { keep: 3, restore: true, count: 0, bytes: 0 },
    },
    {
      name: "nightly",
      schedule: "0 5 * * *",
      timeZone: "Europe/London",
      state: "idle",
      scheduled: false,
      timeout: 600,
      reason:
        "jobs.nightly.targets does not name stable, so its schedule never runs it here; once stable is deployed, rig run runs it.",
    },
  ]);
  expect(
    configuredJobs(patchedSettings(config, "working"), "working", UTC)[1]!
      .reason,
  ).toBe(
    "working is not up yet, so its jobs are not scheduled; rig up schedules them.",
  );
});

test("configuredTarget and unrecordedReport show a Target only rig.yaml has as configured, refusing what needs it to exist", () => {
  const stable = configuredTarget(config, "stable", UTC);
  expect(stable.hostnames).toEqual([
    "stable.app.example.test",
    "api.stable.app.example.test",
  ]);
  const report = unrecordedReport("stable", stable, "app");
  expect(Object.keys(report)).toEqual([
    "name",
    "kind",
    "state",
    "hostnames",
    "refusals",
    "components",
    "jobs",
  ]);
  expect(report).toMatchObject({
    name: "stable",
    kind: "stable",
    state: "configured",
    components: stable.components,
    jobs: stable.jobs,
  });
  expect(Object.keys(report.refusals!)).toEqual([
    "up",
    "restart",
    "run",
    "restore",
  ]);
  const bare = unrecordedReport(
    "working",
    { components: [], hostnames: [], jobs: [] },
    "app",
  );
  expect(bare).not.toHaveProperty("hostnames");
  expect(bare).not.toHaveProperty("jobs");
  expect(Object.keys(bare.refusals!)).toEqual(["restart", "run", "restore"]);
});
