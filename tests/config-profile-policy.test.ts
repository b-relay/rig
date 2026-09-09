import { expect, test } from "bun:test";
import { parseHostConfig, parseProjectConfig } from "../src/config";

test("configuration accepts the supported default profile and refuses profiles that cannot select isolated providers", () => {
  expect(parseHostConfig({}).providers.defaultProfile).toBe("default");
  expect(
    parseProjectConfig({
      name: "app",
      components: {},
      local: { providerProfile: "default" },
    }).local?.providerProfile,
  ).toBe("default");
  for (const profile of ["stub", "isolated-e2e"]) {
    expect(() =>
      parseHostConfig({ providers: { defaultProfile: profile } }),
    ).toThrow("Invalid Host configuration");
    for (const lane of ["local", "live", "deployments"])
      expect(() =>
        parseProjectConfig({
          name: "app",
          components: {},
          [lane]: { providerProfile: profile },
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
