import { expect, test } from "bun:test";
import { parseHostConfig, parseProjectConfig } from "../src/config";

test("an empty Host config resolves every default, in snake_case like rig.yaml", () => {
  expect(parseHostConfig({})).toEqual({
    deploy: {
      production_branch: "main",
      previews: { max: 25, replace_policy: "oldest" },
    },
    providers: { caddy: { extra_config: [], reload: { mode: "manual" } } },
    diagnostics: { retention_days: 14, level: "info" },
    logs: { max_bytes: 64 * 1024 * 1024, generations: 1 },
    alerts: { channels: { macos: {} } },
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

test("the macOS alert channel can be turned off, and an unknown channel is refused", () => {
  expect(
    parseHostConfig({ alerts: { channels: { macos: { enabled: false } } } })
      .alerts,
  ).toEqual({ channels: { macos: { enabled: false } } });
  expect(() =>
    parseHostConfig({ alerts: { channels: { slack: { enabled: true } } } }),
  ).toThrow("Invalid Host configuration.");
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
      services: { web: { run: "./web", workdir: "apps/web" } },
    }),
  ).toThrow("Invalid Project configuration");
  // rigd supervises every Service; no Service chooses its own supervisor.
  expect(() =>
    parseProjectConfig({
      name: "app",
      services: { web: { run: "./web", supervisor: "rigd" } },
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
