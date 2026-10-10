import { expect, test } from "bun:test";
import {
  parseProjectConfig,
  resolveTargetPlan as resolvePlanWithHost,
} from "../src/config/index.js";
import { plannedRoutes, plannedSites } from "../src/runtime/ports";
import { observeTargets } from "../src/runtime/status";
import { timerObservationDeadline } from "../src/runtime/bounded-observations";
import { renderStatus } from "../src/cli/output";
import type { TargetRecord } from "../src/domain/runtime";
import type { TargetRole } from "../src/config/schema";

const RESOLVE_HOST = { operatorHome: "/home/operator", envRoot: "/rig/env" };
const PORTS = { "web.http": 4100, "api.http": 4200, "api.admin": 4201 };

/** Melody: the Project domain reaches web, and api serves a hostname of its own. */
const MELODY = {
  name: "melody",
  domain: "melody.b-relay.com",
  proxy: { "/": "web" },
  services: {
    web: { command: "web --port ${port}", ports: { http: "auto" } },
    api: {
      command: "api --port ${port}",
      ports: { http: "auto" },
      domain: "api.melody.b-relay.com",
    },
  },
  targets: { working: true, stable: true, preview: true },
};

function plan(
  config: Record<string, unknown>,
  target: TargetRole,
  deploymentName?: string,
) {
  return resolvePlanWithHost(
    {
      config: parseProjectConfig(config),
      target,
      workspacePath: "/work",
      dataRoot: "/data",
      ...(deploymentName ? { deploymentName } : {}),
      assignedPorts: PORTS,
    },
    RESOLVE_HOST,
  );
}

/** The ConfigError a parse raised, or undefined when the input was accepted. */
function failureOf(input: unknown) {
  try {
    parseProjectConfig(input);
  } catch (error) {
    return error as {
      code: string;
      hint: string;
      context: { issues?: { path: string[]; message: string }[] };
    };
  }
  return undefined;
}
const issues = (input: unknown) =>
  (failureOf(input)?.context.issues ?? []).map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );

const withApi = (
  api: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  ...MELODY,
  services: { ...MELODY.services, api: { ...MELODY.services.api, ...api } },
  ...extra,
});

test("the stable Target serves the Project domain and every Service domain, published as one route", () => {
  const stable = plan(MELODY, "stable");
  expect(stable.domain).toBe("melody.b-relay.com");
  expect(stable.serviceDomains).toEqual([
    { hostname: "api.melody.b-relay.com", service: "api", port: 4200 },
  ]);
  expect(plannedSites(stable)).toEqual([
    {
      hostname: "melody.b-relay.com",
      routes: [{ prefix: "/", service: "web", port: 4100 }],
    },
    {
      hostname: "api.melody.b-relay.com",
      routes: [{ prefix: "/", service: "api", port: 4200 }],
    },
  ]);
  // Every route of every hostname is withheld while its Service is unverified.
  expect(plannedRoutes(stable).map((route) => route.service)).toEqual([
    "web",
    "api",
  ]);
});

test("a Preview gets the flat form of a Service domain, and the working Target none unless its patch sets one", () => {
  expect(plan(MELODY, "preview", "feat-x-1a2b3c4d").serviceDomains).toEqual([
    {
      hostname: "api-feat-x-1a2b3c4d.melody.b-relay.com",
      service: "api",
      port: 4200,
    },
  ]);
  const working = plan(MELODY, "working");
  expect(working).not.toHaveProperty("serviceDomains");
  expect(plannedSites(working)).toEqual([]);

  const patched = {
    ...MELODY,
    targets: {
      stable: true,
      working: {
        services: { api: { domain: "api.melody.localhost" } },
      },
      preview: {
        services: {
          api: { domain: "${rig.target}.api.preview.melody.b-relay.com" },
        },
      },
    },
  };
  expect(plan(patched, "working").serviceDomains).toEqual([
    { hostname: "api.melody.localhost", service: "api", port: 4200 },
  ]);
  // The working Target still has no domain of its own: only the Service domain its patch set.
  expect(plan(patched, "working")).not.toHaveProperty("domain");
  expect(plan(patched, "preview", "feat-x").serviceDomains).toEqual([
    {
      hostname: "feat-x.api.preview.melody.b-relay.com",
      service: "api",
      port: 4200,
    },
  ]);
  expect(plan(patched, "stable").serviceDomains).toEqual([
    { hostname: "api.melody.b-relay.com", service: "api", port: 4200 },
  ]);
});

test("a Project with no domain may still give a Service one, and a plan without Service domains records none", () => {
  const { domain: _domain, proxy: _proxy, ...rest } = MELODY;
  const alone = plan(rest, "stable");
  expect(alone).not.toHaveProperty("domain");
  expect(alone.serviceDomains).toEqual([
    { hostname: "api.melody.b-relay.com", service: "api", port: 4200 },
  ]);
  // No key at all, so a Target recorded before Service domains shows no drift.
  const plain = plan(
    withApi({ domain: undefined }, { services: { web: MELODY.services.web } }),
    "stable",
  );
  expect(plain).not.toHaveProperty("serviceDomains");
});

test("a Service with several ports names the one its domain reaches; an unclear or unknown port is refused with the fix", () => {
  const twoPorts = { command: "api", ports: { http: "auto", admin: "auto" } };
  expect(issues(withApi(twoPorts))).toEqual([
    "services.api.domain: 'api' has 2 ports (http, admin); name the one this domain reaches, such as domain: { host: ..., port: http }.",
  ]);
  expect(
    plan(
      withApi({
        ...twoPorts,
        domain: { host: "api.melody.b-relay.com", port: "admin" },
      }),
      "stable",
    ).serviceDomains,
  ).toEqual([
    { hostname: "api.melody.b-relay.com", service: "api", port: 4201 },
  ]);
  expect(
    issues(
      withApi({ domain: { host: "api.melody.b-relay.com", port: "rpc" } }),
    ),
  ).toEqual([
    "services.api.domain: 'api' declares no port 'rpc'; its ports are http.",
  ]);
  expect(
    issues({
      ...MELODY,
      services: {
        ...MELODY.services,
        worker: { command: "work", domain: "worker.melody.b-relay.com" },
      },
    }),
  ).toEqual([
    "services.worker.domain: 'worker' declares no port for this domain to reach; declare one, such as ports: { http: auto }, or remove the domain.",
  ]);
});

test("a role that does not serve a Service domain is not checked for its port", () => {
  // The working Target serves no Service domain its patch does not set, so a second port there is no ambiguity.
  const config = withApi(
    { command: "api --port ${ports.http}" },
    {
      targets: {
        stable: true,
        working: { services: { api: { ports: { debug: 9229 } } } },
      },
    },
  );
  expect(failureOf(config)).toBeUndefined();
  expect(plan(config, "working")).not.toHaveProperty("serviceDomains");
  // Messages fit the 160 characters a refusal shows, even with long names.
  const long = withApi({
    command: "api",
    ports: { "http-public": "auto", "admin-internal": "auto" },
    domain: "dashboard-api.staging.melody.b-relay.com",
  });
  const refused = failureOf(long)?.context.issues ?? [];
  expect(refused.length).toBe(1);
  for (const issue of refused) expect(issue.message.endsWith(".")).toBe(true);
});

test("a role patch replaces a Service's host and keeps the port the top level names", () => {
  const config = withApi(
    {
      command: "api",
      ports: { http: "auto", admin: "auto" },
      domain: { host: "api.melody.b-relay.com", port: "admin" },
    },
    {
      targets: {
        stable: {
          services: { api: { domain: { host: "admin.melody.test" } } },
        },
      },
    },
  );
  expect(plan(config, "stable").serviceDomains).toEqual([
    { hostname: "admin.melody.test", service: "api", port: 4201 },
  ]);
  // A plain hostname replaces the map, port included, so the patch is refused where it is written.
  const plain = withApi(
    {
      command: "api",
      ports: { http: "auto", admin: "auto" },
      domain: { host: "api.melody.b-relay.com", port: "admin" },
    },
    {
      targets: {
        stable: { services: { api: { domain: "admin.melody.test" } } },
      },
    },
  );
  expect(issues(plain)).toEqual([
    "targets.stable.services.api.domain: 'api' has 2 ports (http, admin); name the one this domain reaches, such as domain: { host: ..., port: http }.",
  ]);
});

test("every hostname of a Target must differ, the Project domain included, ignoring case", () => {
  expect(issues(withApi({ domain: "Melody.b-relay.com" }))).toEqual([
    "services.api.domain: domain gives this Target the same hostname; each hostname of a Target must differ.",
  ]);
  expect(
    issues({
      ...MELODY,
      services: {
        ...MELODY.services,
        web: { ...MELODY.services.web, domain: "api.melody.b-relay.com" },
      },
    }),
  ).toContain(
    "services.api.domain: services.web.domain gives this Target the same hostname; each hostname of a Target must differ.",
  );
  // A role patch is checked against the hostnames of its own role.
  expect(
    issues({
      ...MELODY,
      targets: {
        stable: true,
        preview: { domain: "${rig.target}.preview.test" },
        working: {
          domain: "melody.localhost",
          services: { api: { domain: "melody.localhost" } },
        },
      },
    }),
  ).toEqual([
    "targets.working.services.api.domain: targets.working.domain gives this Target the same hostname; each hostname of a Target must differ.",
  ]);
  // Hostnames that only meet once ${rig.target} is replaced are refused when the Target is planned.
  const meeting = {
    ...MELODY,
    targets: {
      working: {
        domain: "working.melody.localhost",
        services: { api: { domain: "${rig.target}.melody.localhost" } },
      },
    },
  };
  expect(failureOf(meeting)).toBeUndefined();
  expect(() => plan(meeting, "working")).toThrow(
    expect.objectContaining({
      code: "duplicate_hostname",
      message:
        "The working Target would serve working.melody.localhost twice, from domain and services.api.domain.",
    }),
  );
});

test("a Service domain follows the domain rules: one hostname, ${rig.target} its only reference, labels DNS can hold", () => {
  for (const domain of [
    "https://api.melody.b-relay.com",
    "api.melody.b-relay.com:8443",
    "*.melody.b-relay.com",
    "${environment.HOST}",
  ])
    expect(issues(withApi({ domain }))).toEqual([
      "services.api.domain: must be a hostname such as app.test or ${rig.target}.app.test; schemes, ports, paths, wildcards, lists and other references are not allowed",
    ]);
  expect(issues(withApi({ domain: { host: "api.test", path: "/" } }))).toEqual([
    'services.api.domain: has no field named "path"',
  ]);
  const long = `${"b".repeat(40)}-1a2b3c4d`;
  expect(() =>
    plan(withApi({ domain: "api-recipes-store.melody.test" }), "preview", long),
  ).toThrow(
    expect.objectContaining({
      code: "hostname_label_too_long",
      context: {
        domain: `api-recipes-store-${long}.melody.test`,
        label: `api-recipes-store-${long}`,
        path: "services.api.domain",
      },
      hint: expect.stringContaining(
        "set targets.preview.services.api.domain to a pattern such as ${rig.target}.api.preview.example.com",
      ),
    }),
  );
});

test("status lists every hostname, beside the Service each reaches", async () => {
  const stable = plan(MELODY, "stable");
  const record = {
    id: "t",
    name: "stable",
    kind: "stable",
    branch: "main",
    commit: "abc1234",
    plan: stable,
  } as unknown as TargetRecord;
  const [report] = await observeTargets(
    [record],
    {
      process: async () => ({ state: "running", pid: 22 }),
      health: async () => ({ ready: true }),
      artifact: async () => "installed",
      listening: async () => [],
      persistent: async () => true,
    },
    1000,
    timerObservationDeadline,
  );
  expect(report!.route).toBe("melody.b-relay.com");
  expect(report!.hostnames).toEqual([
    "melody.b-relay.com",
    "api.melody.b-relay.com",
  ]);
  expect(
    report!.components.map(({ name, route, hostnames }) => ({
      name,
      route,
      hostnames,
    })),
  ).toEqual([
    {
      name: "web",
      route: "melody.b-relay.com",
      hostnames: ["melody.b-relay.com"],
    },
    {
      name: "api",
      route: "api.melody.b-relay.com",
      hostnames: ["api.melody.b-relay.com"],
    },
  ]);
  const text = renderStatus(
    { project: "melody", targets: [report!] },
    new Date(0),
  );
  expect(text).toContain("  web  running  :4100  melody.b-relay.com\n");
  expect(text).toContain("  api  running  :4200  api.melody.b-relay.com\n");
  expect(text).not.toContain("Route");
});

test("a Service reached by two hostnames shows both, and a hostname no Service line shows gets a Route line", () => {
  const text = renderStatus(
    {
      project: "melody",
      targets: [
        {
          name: "stable",
          kind: "stable",
          state: "running",
          route: "melody.b-relay.com",
          hostnames: ["melody.b-relay.com", "www.melody.b-relay.com"],
          components: [
            {
              name: "web",
              kind: "managed",
              state: "running",
              port: 4100,
              route: "melody.b-relay.com",
              hostnames: ["melody.b-relay.com", "www.melody.b-relay.com"],
            },
          ],
        },
        {
          name: "feat-x",
          kind: "preview",
          state: "stopped",
          route: "melody-feat-x.b-relay.com",
          hostnames: [
            "melody-feat-x.b-relay.com",
            "api-feat-x.melody.b-relay.com",
          ],
          components: [
            {
              name: "api",
              kind: "managed",
              state: "stopped",
              route: "api-feat-x.melody.b-relay.com",
            },
          ],
        },
      ],
    },
    new Date(0),
  );
  expect(text).toContain(
    "  web  running  :4100  melody.b-relay.com, www.melody.b-relay.com\n",
  );
  expect(text).toContain("  Route  melody-feat-x.b-relay.com\n");
  expect(text).toContain("  api  stopped  api-feat-x.melody.b-relay.com\n");
});
