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
  });
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
  // The supervisor is chosen for a whole Target, never for one Service.
  expect(() =>
    parseProjectConfig({
      name: "app",
      supervisor: "rigd",
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
