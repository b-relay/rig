import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { decodeRigProjectConfig, decodeRigStatusInput, resolveRigLane } from "./config.js"

describe("GIVEN rig Effect Schema validation WHEN decoding representative inputs THEN behavior is covered", () => {
  test("GIVEN a valid rig project config WHEN decoding THEN managed and installed components are accepted", async () => {
    const result = await Effect.runPromise(
      decodeRigProjectConfig({
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
      decodeRigProjectConfig({
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

    expect(error._tag).toBe("RigConfigValidationError")
    expect(error.message).toBe("Invalid rig project config.")
    expect(String(error.details?.cause)).toContain("localhost")
  })

  test("GIVEN non-integer runtime ports WHEN decoding THEN schema validation rejects them", async () => {
    const error = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "bun run start",
            port: 3070.5,
          },
        },
      }).pipe(Effect.flip),
    )

    expect(error._tag).toBe("RigConfigValidationError")
    expect(String(error.details?.cause)).toContain("integer")
  })

  test("GIVEN explicit non-localhost host bindings WHEN decoding THEN schema validation rejects them", async () => {
    const commandError = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "bun run dev -- --host 192.168.1.20 --port 3070",
          },
        },
      }).pipe(Effect.flip),
    )
    const healthError = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "bun run dev -- --host=127.0.0.1 --port 3070",
            health: "http://[::]:3070/health",
          },
        },
      }).pipe(Effect.flip),
    )

    expect(commandError._tag).toBe("RigConfigValidationError")
    expect(String(commandError.details?.cause)).toContain("localhost")
    expect(healthError._tag).toBe("RigConfigValidationError")
    expect(String(healthError.details?.cause)).toContain("localhost")
  })

  test("GIVEN invalid rig status input WHEN decoding THEN project validation fails through Effect Schema", async () => {
    const error = await Effect.runPromise(
      decodeRigStatusInput({
        project: "../pantry",
        stateRoot: "/tmp/rig",
      }).pipe(Effect.flip),
    )

    expect(error._tag).toBe("RigConfigValidationError")
    expect(error.message).toBe("Invalid rig status input.")
  })
})

describe("GIVEN rig config resolver WHEN resolving lanes THEN behavior is covered", () => {
  test("GIVEN shared components and local overrides WHEN resolving THEN it returns a first-class runtime plan", async () => {
    const config = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        domain: "pantry.b-relay.com",
        hooks: {
          preStart: "echo ${lane}:${workspace}",
        },
        components: {
          api: {
            mode: "managed",
            command: "bun run start -- --port ${api.port}",
            port: 3070,
            health: "http://127.0.0.1:${api.port}/health",
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
              command: "bun run dev -- --port ${api.port}",
              port: 5173,
              health: "http://127.0.0.1:${api.port}",
            },
          },
        },
      }),
    )

    const resolved = await Effect.runPromise(
      resolveRigLane(config, {
        lane: "local",
        workspacePath: "/tmp/pantry",
      }),
    )

    expect(resolved.runtimePlan).toMatchObject({
      project: "pantry",
      lane: "local",
      deploymentName: "local",
      workspacePath: "/tmp/pantry",
      dataRoot: "/tmp/pantry/.rig-data",
      providerProfile: "default",
      providers: {
        processSupervisor: "rigd",
      },
      proxy: {
        upstream: "api",
      },
      hooks: {
        preStart: "echo local:/tmp/pantry",
      },
      components: [
        {
          name: "api",
          kind: "managed",
          command: "bun run dev -- --port 5173",
          port: 5173,
          health: "http://127.0.0.1:5173",
          envFile: ".env.local",
        },
        {
          name: "cli",
          kind: "installed",
          entrypoint: "src/index.ts",
          build: "bun run build",
          envFile: ".env.local",
        },
      ],
    })
    expect(resolved.runtimePlan.components.map((component) => component.kind)).toEqual(["managed", "installed"])
    expect(JSON.stringify(resolved.runtimePlan)).not.toContain('"server"')
    expect(JSON.stringify(resolved.runtimePlan)).not.toContain('"bin"')
    expect(resolved.v1Config.environments.dev).toBe(resolved.environment)
  })

  test("GIVEN shared components and local overrides WHEN resolving THEN it produces v1-compatible lifecycle config", async () => {
    const config = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        domain: "pantry.b-relay.com",
        hooks: {
          preStart: "echo ${lane}:${workspace}",
        },
        components: {
          api: {
            mode: "managed",
            command: "bun run start -- --port ${api.port}",
            port: 3070,
            health: "http://127.0.0.1:${api.port}/health",
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
              command: "bun run dev -- --port ${api.port}",
              port: 5173,
              health: "http://127.0.0.1:${api.port}",
            },
          },
        },
      }),
    )

    const resolved = await Effect.runPromise(
      resolveRigLane(config, {
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
      command: "bun run dev -- --port 5173",
      port: 5173,
      healthCheck: "http://127.0.0.1:5173",
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
      decodeRigProjectConfig({
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
      resolveRigLane(config, {
        lane: "live",
        workspacePath: "/tmp/pantry-live",
      }),
    )

    expect(resolved.providers).toEqual({
      processSupervisor: "launchd",
    })
  })

  test("GIVEN stub provider profile WHEN resolving THEN stub process supervision is the lane default", async () => {
    const config = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "managed",
            command: "bun run start",
            port: 3070,
          },
        },
        live: {
          providerProfile: "stub",
        },
      }),
    )

    const resolved = await Effect.runPromise(
      resolveRigLane(config, {
        lane: "live",
        workspacePath: "/tmp/pantry-live",
      }),
    )

    expect(resolved.providerProfile).toBe("stub")
    expect(resolved.providers).toEqual({
      processSupervisor: "stub-process-supervisor",
    })
  })

  test("GIVEN pantry live config WHEN resolving THEN the domain proxy and CLI install name are ready for cutover", async () => {
    const config = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        domain: "pantry.b-relay.com",
        components: {
          web: {
            mode: "managed",
            command: "bun run start -- --host 127.0.0.1 --port ${web.port}",
            port: 3070,
            health: "http://127.0.0.1:${web.port}/health",
          },
          cli: {
            mode: "installed",
            entrypoint: "dist/pantry",
            build: "bun build --compile cli/index.ts --outfile dist/pantry",
            installName: "pantry",
          },
        },
        live: {
          proxy: {
            upstream: "web",
          },
          providers: {
            processSupervisor: "launchd",
          },
        },
      }),
    )

    const resolved = await Effect.runPromise(
      resolveRigLane(config, {
        lane: "live",
        workspacePath: "/tmp/rig/workspaces/pantry/live",
      }),
    )

    expect(resolved.v1Config.domain).toBe("pantry.b-relay.com")
    expect(resolved.environment.proxy?.upstream).toBe("web")
    expect(resolved.environment.services).toContainEqual(expect.objectContaining({
      name: "pantry",
      type: "bin",
      entrypoint: "dist/pantry",
      build: "bun build --compile cli/index.ts --outfile dist/pantry",
    }))
    expect(resolved.environment.services).toContainEqual(expect.objectContaining({
      name: "web",
      type: "server",
      command: "bun run start -- --host 127.0.0.1 --port 3070",
      healthCheck: "http://127.0.0.1:3070/health",
    }))
  })

  test("GIVEN generated deployment interpolation WHEN resolving THEN branch values and assigned ports are substituted", async () => {
    const config = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        domain: "${subdomain}.preview.b-relay.com",
        components: {
          web: {
            mode: "managed",
            command: "bun run start -- --port ${web.port}",
            health: "http://127.0.0.1:${web.port}/health",
          },
        },
        deployments: {
          subdomain: "${branchSlug}",
          providerProfile: "stub",
        },
      }),
    )

    const resolved = await Effect.runPromise(
      resolveRigLane(config, {
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

  test("GIVEN configured live ports and reserved ports WHEN resolving THEN interpolation uses configured ports consistently", async () => {
    const config = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        components: {
          convex: {
            mode: "managed",
            command: "PANTRY_PROD_CONVEX_PORT=${convex.port} ./scripts/start-convex.sh prod",
            port: 3210,
            health: "http://127.0.0.1:${convex.port}/version",
            hooks: {
              postStart: "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:${convex.port} bun run convex:push:prod",
            },
          },
          web: {
            mode: "managed",
            command: "VITE_CONVEX_URL=http://127.0.0.1:${convex.port} vite --port ${web.port}",
            port: 5173,
            dependsOn: ["convex"],
          },
          cli: {
            mode: "installed",
            entrypoint: "dist/pantry",
            build: "PANTRY_DEFAULT_CONVEX_URL=http://127.0.0.1:${convex.port} bun build",
          },
        },
        live: {
          components: {
            convex: {
              port: 43290,
            },
            web: {
              port: 43070,
            },
          },
        },
      }),
    )

    const resolved = await Effect.runPromise(
      resolveRigLane(config, {
        lane: "live",
        workspacePath: "/tmp/pantry-live",
        assignedPorts: {
          convex: 48340,
          web: 61351,
        },
      }),
    )

    expect(resolved.environment.services[0]).toMatchObject({
      name: "convex",
      command: "PANTRY_PROD_CONVEX_PORT=43290 ./scripts/start-convex.sh prod",
      port: 43290,
      healthCheck: "http://127.0.0.1:43290/version",
      hooks: {
        postStart: "CONVEX_SELF_HOSTED_URL=http://127.0.0.1:43290 bun run convex:push:prod",
      },
    })
    expect(resolved.environment.services[1]).toMatchObject({
      name: "web",
      command: "VITE_CONVEX_URL=http://127.0.0.1:43290 vite --port 43070",
      port: 43070,
    })
    expect(resolved.environment.services[2]).toMatchObject({
      name: "cli",
      build: "PANTRY_DEFAULT_CONVEX_URL=http://127.0.0.1:43290 bun build",
    })
    expect(JSON.stringify(resolved.environment)).not.toContain("48340")
    expect(JSON.stringify(resolved.environment)).not.toContain("61351")
  })

  test("GIVEN installed component with managed-only field WHEN decoding THEN it fails with structured mode error", async () => {
    const error = await Effect.runPromise(
      decodeRigProjectConfig({
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

    expect(error._tag).toBe("RigConfigValidationError")
    expect(String(error.details?.cause)).toContain("invalid mode-specific fields")
    expect(JSON.stringify(error.details?.issues)).toContain("invalid_mode_field")
  })

  test("GIVEN managed component depending on installed component WHEN decoding THEN dependency validation fails", async () => {
    const error = await Effect.runPromise(
      decodeRigProjectConfig({
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

    expect(error._tag).toBe("RigConfigValidationError")
    expect(JSON.stringify(error.details?.issues)).toContain("invalid_dependency")
  })

  test("GIVEN proxy upstream pointing at installed component WHEN decoding THEN proxy validation fails", async () => {
    const error = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        components: {
          web: {
            mode: "installed",
            entrypoint: "dist/web",
          },
        },
        live: {
          proxy: {
            upstream: "web",
          },
        },
      }).pipe(Effect.flip),
    )

    expect(error._tag).toBe("RigConfigValidationError")
    expect(JSON.stringify(error.details?.issues)).toContain("invalid_proxy_upstream")
  })

  test("GIVEN empty deploy branch or route directive characters WHEN decoding THEN schema validation fails", async () => {
    const emptyBranch = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        components: {},
        live: {
          deployBranch: "",
        },
      }).pipe(Effect.flip),
    )
    const route = await Effect.runPromise(
      decodeRigProjectConfig({
        name: "pantry",
        domain: "pantry.test;respond",
        components: {},
      }).pipe(Effect.flip),
    )

    expect(emptyBranch._tag).toBe("RigConfigValidationError")
    expect(String(emptyBranch.details?.cause)).toContain("Must not be empty")
    expect(route._tag).toBe("RigConfigValidationError")
    expect(String(route.details?.cause)).toContain("route token")
  })
})
