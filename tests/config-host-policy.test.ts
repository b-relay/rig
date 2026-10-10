import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHostConfig, parseProjectConfig } from "../src/config";
import { inspectHost } from "../src/adapters/host-inspection";

test("an empty Host config resolves every default, in snake_case like rig.yaml", () => {
  expect(parseHostConfig({})).toEqual({
    deploy: {
      production_branch: "main",
      previews: { max: 25, replace_policy: "oldest" },
    },
    providers: { caddy: { extra_config: [], reload: { mode: "manual" } } },
    diagnostics: { retention_days: 14, level: "info" },
    logs: { max_bytes: 64 * 1024 * 1024, generations: 1 },
    proxyMode: "external",
    externalIgnored: false,
  });
});

test("a written proxy section makes Rig run its own Caddy, with every default resolved", () => {
  const host = parseHostConfig({ proxy: { caddy: "/usr/local/bin/caddy" } });
  expect(host.proxyMode).toBe("managed");
  expect(host.externalIgnored).toBe(false);
  expect(host.proxy).toEqual({
    caddy: "/usr/local/bin/caddy",
    ports: { http: 80, https: 443 },
    tls: {
      ca: "letsencrypt",
      dns: "cloudflare",
      certificates: "wildcard",
      resolvers: ["1.1.1.1", "1.0.0.1"],
    },
    site: [],
  });
  // providers.caddy written beside it is ignored, and said to be.
  expect(
    parseHostConfig({
      proxy: { caddy: "/usr/local/bin/caddy" },
      providers: { caddy: { extra_config: ["import cloudflare"] } },
    }),
  ).toMatchObject({ proxyMode: "managed", externalIgnored: true });
  expect(parseHostConfig({ providers: { caddy: {} } }).proxyMode).toBe(
    "external",
  );
});

test("proxy refuses a relative Caddy, ports that cannot be served together, a multi-line site directive, and an unknown CA", () => {
  for (const proxy of [
    { caddy: "caddy" },
    { caddy: "/c", ports: { http: 80, https: 80 } },
    { caddy: "/c", ports: { http: 80, https: 8443 } },
    { caddy: "/c", site: ["import a\nimport b"] },
    { caddy: "/c", tls: { ca: "zerossl" } },
    { caddy: "/c", tls: { ca: "http://acme.test/directory" } },
    { caddy: "/c", tls: { resolvers: ["one.one.one.one"] } },
    { caddy: "/c", tls: { dns: "route53" } },
    { caddy: "/c", unknown: true },
  ])
    expect(() => parseHostConfig({ proxy })).toThrow();
  expect(
    parseHostConfig({
      proxy: {
        caddy: "/c",
        ports: { http: 28080, https: 28443 },
        tls: {
          ca: "https://acme.test/directory",
          email: "ops@example.com",
          certificates: "hostname",
        },
        site: ["import backend_errors"],
      },
    }).proxy,
  ).toMatchObject({
    ports: { http: 28080, https: 28443 },
    tls: { ca: "https://acme.test/directory", certificates: "hostname" },
  });
});

test("Target log retention takes a size of at least 1 MiB and 0 to 20 kept generations", () => {
  expect(
    parseHostConfig({ logs: { max_bytes: 1048576, generations: 0 } }).logs,
  ).toEqual({ max_bytes: 1048576, generations: 0 });
  expect(parseHostConfig({ logs: { generations: 20 } }).logs).toEqual({
    max_bytes: 67108864,
    generations: 20,
  });
  for (const logs of [
    { max_bytes: 1048575 },
    { max_bytes: 1048576.5 },
    { max_bytes: "64MiB" },
    { generations: -1 },
    { generations: 21 },
    { generations: 1.5 },
    { maxBytes: 1048576 },
  ])
    expect(() => parseHostConfig({ logs })).toThrow(
      "Invalid Host configuration",
    );
});

test("a Host config that still has the retired alerts section is read, and doctor asks for the section to be deleted", async () => {
  // rigd reads the Host config as it starts, so a section it no longer uses must not keep it from starting.
  for (const alerts of [
    { channels: { macos: { enabled: false } } },
    { channels: { slack: { enabled: true } } },
    null,
  ])
    expect(parseHostConfig({ alerts }).deploy.production_branch).toBe("main");
  const root = await mkdtemp(join(tmpdir(), "rig-host-alerts-"));
  try {
    const checks = async () =>
      (await inspectHost(root)).filter((check) =>
        check.name.startsWith("host-config"),
      );
    await writeFile(join(root, "config.yaml"), "diagnostics:\n  level: warn\n");
    expect(await checks()).toEqual([
      {
        name: "host-config",
        ok: true,
        message: "Host configuration is valid.",
      },
    ]);
    await writeFile(
      join(root, "config.yaml"),
      "alerts:\n  channels:\n    macos:\n      enabled: false\n",
    );
    expect(await checks()).toEqual([
      {
        name: "host-config",
        ok: true,
        message: "Host configuration is valid.",
      },
      {
        name: "host-config/alerts",
        ok: false,
        message:
          "The Host config has an alerts section, which Rig no longer uses; it is ignored.",
        reason: "config-retired",
        hint: "Delete the alerts section from config.yaml under the Rig root; Rig no longer sends alerts.",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Host config refuses the settings Rig never read and the old key names", () => {
  for (const config of [
    { web: {} },
    { web: { controlPlane: "localhost" } },
    { providers: { defaultProfile: "default" } },
    { deploy: { generated: { maxActive: 3 } } },
    { deploy: { productionBranch: "release" } },
    { providers: { caddy: { hostCaddyfile: "/etc/caddy/Caddyfile" } } },
    { diagnostics: { retentionDays: 3 } },
  ])
    expect(() => parseHostConfig(config)).toThrow("Invalid Host configuration");
});

test("a Project cannot select a provider profile, a Service workdir or a Service supervisor", () => {
  const project = { name: "app", tools: { cli: { bin: "bin/cli" } } };
  expect(() =>
    parseProjectConfig({ ...project, providerProfile: "default" }),
  ).toThrow("Invalid Project configuration");
  expect(() =>
    parseProjectConfig({
      name: "app",
      services: { web: { command: "./web", workdir: "apps/web" } },
    }),
  ).toThrow("Invalid Project configuration");
  // rigd supervises every Service; no Service chooses its own supervisor.
  expect(() =>
    parseProjectConfig({
      name: "app",
      services: { web: { command: "./web", supervisor: "rigd" } },
    }),
  ).toThrow("Invalid Project configuration");
});

test("Caddy reload is manual or an explicit nonblank command", () => {
  for (const command of [undefined, "", "   ", "\t\n"])
    expect(() =>
      parseHostConfig({
        providers: {
          caddy: {
            reload: {
              mode: "command",
              ...(command === undefined ? {} : { command }),
            },
          },
        },
      }),
    ).toThrow("Invalid Host configuration");
  expect(
    parseHostConfig({
      providers: {
        caddy: {
          reload: {
            mode: "command",
            command: "caddy reload --config /owned/Caddyfile",
          },
        },
      },
    }).providers.caddy.reload,
  ).toEqual({
    mode: "command",
    command: "caddy reload --config /owned/Caddyfile",
  });
  // "disabled" behaved exactly like manual, so only manual remains.
  expect(() =>
    parseHostConfig({ providers: { caddy: { reload: { mode: "disabled" } } } }),
  ).toThrow("Invalid Host configuration");
});
