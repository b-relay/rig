import { describe, expect, test } from "bun:test"
import { Effect } from "effect-v4"

import { decodeV2ProjectConfig, decodeV2StatusInput, resolveV2Lane } from "./config.js"

describe("GIVEN v2 Effect Schema validation WHEN decoding representative inputs THEN behavior is covered", () => {
  test("GIVEN a valid v2 project config WHEN decoding THEN managed and installed components are accepted", async () => {
    const result = await Effect.runPromise(
      decodeV2ProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "bun run start",
            port: 3070,
            health: "http://127.0.0.1:3070/health",
          },
          cli: {
            mode: "installed",
            entrypoint: "src/index.ts",
            build: "bun run build",
          },
        },
        local: {
          components: {
            web: {
              command: "bun run dev -- --host 127.0.0.1",
              health: "http://127.0.0.1:5173",
            },
          },
        },
      }),
    )

    expect(result.name).toBe("pantry")
    expect(result.components.web?.mode).toBe("managed")
    expect(result.components.cli?.mode).toBe("installed")
  })

  test("GIVEN a health check targeting 0.0.0.0 WHEN decoding THEN schema validation returns a tagged error", async () => {
    const error = await Effect.runPromise(
      decodeV2ProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "bun run start",
            health: "http://0.0.0.0:3070/health",
          },
        },
      }).pipe(Effect.flip),
    )

    expect(error._tag).toBe("V2ConfigValidationError")
    expect(error.message).toBe("Invalid v2 project config.")
    expect(String(error.details?.cause)).toContain("0.0.0.0")
  })

  test("GIVEN invalid rig2 status input WHEN decoding THEN project validation fails through Effect Schema", async () => {
    const error = await Effect.runPromise(
      decodeV2StatusInput({
        project: "../pantry",
        stateRoot: "/tmp/rig-v2",
      }).pipe(Effect.flip),
    )

    expect(error._tag).toBe("V2ConfigValidationError")
    expect(error.message).toBe("Invalid rig2 status input.")
  })
})

describe("GIVEN v2 config resolver WHEN resolving lanes THEN behavior is covered", () => {
  test("GIVEN shared components and local overrides WHEN resolving THEN it produces v1-compatible lifecycle config", async () => {
    const config = await Effect.runPromise(
      decodeV2ProjectConfig({
        name: "pantry",
        domain: "pantry.b-relay.com",
        hooks: {
          preStart: "echo ${lane}:${workspace}",
        },
        components: {
          api: {
            mode: "managed",
            command: "bun run start -- --port ${port.api}",
            port: 3070,
            health: "http://127.0.0.1:${port.api}/health",
          },
          worker: {
            mode: "managed",
            command: "bun run worker",
            port: 3071,
            dependsOn: ["api"],
          },
          cli: {
            mode: "installed",
            entrypoint: "src/index.ts",
            build: "bun run build",
          },
        },
        local: {
          envFile: ".env.local",
          proxy: {
            upstream: "api",
          },
          components: {
            api: {
              command: "bun run dev -- --port ${port.api}",
              port: 5173,
              health: "http://127.0.0.1:${port.api}",
            },
          },
        },
      }),
    )

    const resolved = await Effect.runPromise(
      resolveV2Lane(config, {
        lane: "local",
        workspacePath: "/tmp/pantry",
        assignedPorts: {
          api: 9999,
        },
      }),
    )

    expect(resolved.providerProfile).toBe("default")
    expect(resolved.providers).toEqual({
      processSupervisor: "rigd",
    })
    expect(resolved.environment.proxy?.upstream).toBe("api")
    expect(resolved.environment.services).toHaveLength(3)
    expect(resolved.environment.services[0]).toMatchObject({
      name: "api",
      type: "server",
      command: "bun run dev -- --port 9999",
      port: 5173,
      healthCheck: "http://127.0.0.1:9999",
      envFile: ".env.local",
    })
    expect(resolved.environment.services[1]).toMatchObject({
      name: "worker",
      type: "server",
      dependsOn: ["api"],
    })
    expect(resolved.environment.services[2]).toMatchObject({
      name: "cli",
      type: "bin",
      entrypoint: "src/index.ts",
    })
    expect(resolved.v1Config.environments.dev).toBe(resolved.environment)
    expect(resolved.v1Config.environments.prod).toBeUndefined()
    expect(resolved.v1Config.hooks?.preStart).toBe("echo local:/tmp/pantry")
  })

  test("GIVEN lane provider selections WHEN resolving THEN process supervisor provider ids are preserved", async () => {
    const config = await Effect.runPromise(
      decodeV2ProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "bun run start",
            port: 3070,
          },
        },
        live: {
          providers: {
            processSupervisor: "launchd",
          },
        },
      }),
    )

    const resolved = await Effect.runPromise(
      resolveV2Lane(config, {
        lane: "live",
        workspacePath: "/tmp/pantry-live",
      }),
    )

    expect(resolved.providers).toEqual({
      processSupervisor: "launchd",
    })
  })

  test("GIVEN generated deployment interpolation WHEN resolving THEN branch values and assigned ports are substituted", async () => {
    const config = await Effect.runPromise(
      decodeV2ProjectConfig({
        name: "pantry",
        domain: "${subdomain}.preview.b-relay.com",
        components: {
          web: {
            mode: "managed",
            command: "bun run start -- --port ${ports.web}",
            health: "http://127.0.0.1:${ports.web}/health",
          },
        },
        deployments: {
          subdomain: "${branchSlug}",
          providerProfile: "stub",
        },
      }),
    )

    const resolved = await Effect.runPromise(
      resolveV2Lane(config, {
        lane: "deployment",
        workspacePath: "/tmp/pantry-previews/feature-a",
        deploymentName: "feature-a",
        branchSlug: "feature-a",
        assignedPorts: {
          web: 43123,
        },
      }),
    )

    expect(resolved.providerProfile).toBe("stub")
    expect(resolved.subdomain).toBe("feature-a")
    expect(resolved.environment.services[0]).toMatchObject({
      command: "bun run start -- --port 43123",
      port: 43123,
      healthCheck: "http://127.0.0.1:43123/health",
    })
    expect(resolved.v1Config.domain).toBe("feature-a.preview.b-relay.com")
    expect(resolved.v1Config.environments.prod).toBe(resolved.environment)
  })

  test("GIVEN installed component with managed-only field WHEN decoding THEN it fails with structured mode error", async () => {
    const error = await Effect.runPromise(
      decodeV2ProjectConfig({
        name: "pantry",
        components: {
          cli: {
            mode: "installed",
            entrypoint: "src/index.ts",
            port: 3070,
          },
        },
      }).pipe(Effect.flip),
    )

    expect(error._tag).toBe("V2ConfigValidationError")
    expect(String(error.details?.cause)).toContain("invalid mode-specific fields")
    expect(JSON.stringify(error.details?.issues)).toContain("invalid_mode_field")
  })

  test("GIVEN managed component depending on installed component WHEN decoding THEN dependency validation fails", async () => {
    const error = await Effect.runPromise(
      decodeV2ProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "bun run start",
            port: 3070,
            dependsOn: ["cli"],
          },
          cli: {
            mode: "installed",
            entrypoint: "src/index.ts",
          },
        },
      }).pipe(Effect.flip),
    )

    expect(error._tag).toBe("V2ConfigValidationError")
    expect(JSON.stringify(error.details?.issues)).toContain("invalid_dependency")
  })
})
