import { expect, test } from "bun:test";
import { parseHostConfig, parseProjectConfig } from "../src/config";

test("Host configuration accepts only the default provider profile, and Project configuration cannot select a profile at all", () => {
  expect(parseHostConfig({}).providers.defaultProfile).toBe("default");
  for (const profile of ["stub", "isolated-e2e"]) {
    expect(() =>
      parseHostConfig({ providers: { defaultProfile: profile } }),
    ).toThrow("Invalid Host configuration");
  }
  // Provider profiles are Host policy only: a Project cannot select one, at the top level or in a Target patch.
  for (const profile of ["default", "stub"]) {
    const project = { name: "app", tools: { cli: { bin: "bin/cli" } } };
    expect(() =>
      parseProjectConfig({ ...project, providerProfile: profile }),
    ).toThrow("Invalid Project configuration");
    for (const role of ["working", "stable", "preview"])
      expect(() =>
        parseProjectConfig({
          ...project,
          targets: { [role]: { providerProfile: profile } },
        }),
      ).toThrow("Invalid Project configuration");
  }
});

test("Caddy command reload requires an explicit nonblank command while manual and disabled modes need none", () => {
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
  for (const mode of ["manual", "disabled"] as const)
    expect(
      parseHostConfig({ providers: { caddy: { reload: { mode } } } }).providers
        .caddy.reload.mode,
    ).toBe(mode);
});
