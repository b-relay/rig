import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect-v4"

import { runRig2Cli } from "./cli.js"
import {
  V2DeployIntents,
  type V2BumpInput,
  type V2CliDeployInput,
  type V2GitPushDeployInput,
} from "./deploy-intent.js"
import { V2Doctor, type V2DoctorReportInput } from "./doctor.js"
import { V2CliArgumentError, type V2TaggedError } from "./errors.js"
import { V2Lifecycle, type V2LifecycleRequest } from "./lifecycle.js"
import { V2ProjectLocator } from "./project-locator.js"
import { V2ProviderRegistryLive } from "./provider-contracts.js"
import { V2Rigd, type V2RigdProjectInventoryInput, type V2RigdStartInput } from "./rigd.js"
import { V2Logger, V2RuntimeLive, type V2FoundationState } from "./services.js"

class CaptureV2Logger {
  readonly infos: Array<{ readonly message: string; readonly details?: unknown }> = []
  readonly errors: V2TaggedError[] = []

  info(message: string, details?: unknown) {
    this.infos.push({ message, details })
    return Effect.void
  }

  error(error: V2TaggedError) {
    this.errors.push(error)
    return Effect.void
  }
}

class CaptureV2Lifecycle {
  readonly requests: V2LifecycleRequest[] = []

  run(request: V2LifecycleRequest) {
    this.requests.push(request)
    return Effect.void
  }
}

class CaptureV2Rigd {
  readonly healthRequests: V2RigdStartInput[] = []
  readonly inventoryRequests: V2RigdProjectInventoryInput[] = []
  readonly startRequests: V2RigdStartInput[] = []

  start(input: V2RigdStartInput) {
    this.startRequests.push(input)
    return Effect.succeed({
      service: "rigd" as const,
      status: "running" as const,
      stateRoot: input.stateRoot,
      startedAt: "2026-04-24T00:00:00.000Z",
      localApi: {
        transport: "in-process" as const,
        version: "v2-mvp" as const,
      },
      controlPlane: {
        website: "https://rig.b-relay.com" as const,
        transport: "localhost-http" as const,
        bindHost: "127.0.0.1" as const,
        exposure: "localhost-first" as const,
        remoteAccess: ["tailscale-dns", "cloudflare-tunnel-plugin"] as const,
        auth: {
          tailscale: "not-required" as const,
          publicInternet: "token-pairing" as const,
        },
        status: "documented-localhost-first" as const,
      },
      providers: {
        profile: "default" as const,
        families: ["control-plane-transport"] as const,
        providers: [
          {
            id: "localhost-http",
            family: "control-plane-transport" as const,
            source: "first-party" as const,
            displayName: "Localhost HTTP",
            capabilities: ["127.0.0.1-bind"],
          },
        ],
      },
    })
  }

  health(input: V2RigdStartInput) {
    this.healthRequests.push(input)
    return this.start(input)
  }

  inventory(input: V2RigdProjectInventoryInput) {
    this.inventoryRequests.push(input)
    return Effect.succeed({
      project: input.project,
      foundation: {
        project: input.project,
        namespace: `rig.v2.${input.project}`,
        stateRoot: input.stateRoot,
        registryPath: `${input.stateRoot}/registry.json`,
        workspacesRoot: `${input.stateRoot}/workspaces`,
        projectWorkspaceRoot: `${input.stateRoot}/workspaces/${input.project}`,
        logsRoot: `${input.stateRoot}/logs`,
        projectLogRoot: `${input.stateRoot}/logs/${input.project}`,
        runtimeRoot: `${input.stateRoot}/runtime`,
        runtimeStatePath: `${input.stateRoot}/runtime/runtime.json`,
        proxyRoot: `${input.stateRoot}/proxy`,
        proxyNamespace: "rig2",
        launchdLabelPrefix: "com.b-relay.rig2",
        launchdBackupRoot: `${input.stateRoot}/launchd`,
      },
      deployments: [],
    })
  }

  logs() {
    return Effect.succeed([])
  }

  healthState(input: V2RigdProjectInventoryInput) {
    return this.health({ stateRoot: input.stateRoot }).pipe(
      Effect.map((rigd) => ({
        rigd,
        deployments: [],
      })),
    )
  }

  lifecycle() {
    return Effect.die("unused")
  }

  deploy() {
    return Effect.die("unused")
  }
}

class CaptureV2DeployIntents {
  readonly cliDeploys: V2CliDeployInput[] = []
  readonly bumps: V2BumpInput[] = []

  fromGitPush(_input: V2GitPushDeployInput) {
    return Effect.die("unused")
  }

  fromCliDeploy(input: V2CliDeployInput) {
    this.cliDeploys.push(input)
    return Effect.succeed({
      source: "cli" as const,
      project: input.project,
      stateRoot: input.stateRoot,
      ref: input.ref,
      target: input.target,
      lane: input.target === "live" ? "live" as const : "deployment" as const,
      ...(input.deploymentName ? { deploymentName: input.deploymentName } : {}),
    })
  }

  bump(input: V2BumpInput) {
    this.bumps.push(input)
    return Effect.succeed({
      project: input.project,
      previousVersion: input.currentVersion,
      nextVersion: input.set ?? "1.3.0",
      tag: `v${input.set ?? "1.3.0"}`,
      rollbackAnchor: `v${input.currentVersion}`,
    })
  }
}

class CaptureV2Doctor {
  readonly reports: V2DoctorReportInput[] = []

  preflight() {
    return Effect.die("unused")
  }

  report(input: V2DoctorReportInput) {
    this.reports.push(input)
    return Effect.succeed({
      project: input.project,
      ok: true,
      categories: [
        { category: "path" as const, ok: true, details: input.path },
        { category: "binaries" as const, ok: true, details: input.binaries },
        { category: "health" as const, ok: true, details: input.health },
        { category: "ports" as const, ok: true, details: input.ports },
        { category: "stale-state" as const, ok: true, details: input.staleState },
        { category: "providers" as const, ok: true, details: input.providers },
      ],
    })
  }

  reconstruct() {
    return Effect.die("unused")
  }
}

const runWithLogger = async (
  argv: readonly string[],
  options: {
    readonly inferredProject?: string
  } = {},
) => {
  const logger = new CaptureV2Logger()
  const lifecycle = new CaptureV2Lifecycle()
  const rigd = new CaptureV2Rigd()
  const deployIntents = new CaptureV2DeployIntents()
  const doctor = new CaptureV2Doctor()
  const layer = Layer.mergeAll(
    V2RuntimeLive,
    Layer.succeed(V2Logger, logger),
    Layer.succeed(V2Lifecycle, lifecycle),
    Layer.succeed(V2Rigd, rigd),
    Layer.succeed(V2DeployIntents, deployIntents),
    Layer.succeed(V2Doctor, doctor),
    V2ProviderRegistryLive("default"),
    Layer.succeed(V2ProjectLocator, {
      inferCurrentProject: options.inferredProject
        ? Effect.succeed({
          name: options.inferredProject,
          repoPath: "/tmp/repo",
          configPath: "/tmp/repo/rig.json",
        })
        : Effect.fail(
          new V2CliArgumentError(
            "No rig.json found in the current directory.",
            "Run the command from a managed repo or pass --project <name> explicitly.",
          ),
        ),
    }),
  )
  const exitCode = await Effect.runPromise(runRig2Cli(argv).pipe(Effect.provide(layer)))

  return { exitCode, logger, lifecycle, rigd, deployIntents, doctor }
}

describe("GIVEN rig2 Effect CLI foundation WHEN commands run THEN behavior is covered", () => {
  test("GIVEN status command with project and state root WHEN running THEN it reports isolated v2 state", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "status",
      "--project",
      "pantry",
      "--state-root",
      "/tmp/rig-v2",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(logger.infos).toHaveLength(2)
    expect(logger.infos[0]?.message).toBe("rig2 foundation ready")
    expect(logger.infos[1]?.message).toBe("rigd status")

    const state = logger.infos[0]?.details as unknown as V2FoundationState
    expect(state.project).toBe("pantry")
    expect(state.namespace).toBe("rig.v2.pantry")
    expect(state.stateRoot).toBe("/tmp/rig-v2")
    expect(state.registryPath).toBe("/tmp/rig-v2/registry.json")
    expect(state.workspacesRoot).toBe("/tmp/rig-v2/workspaces")
    expect(state.launchdLabelPrefix).toBe("com.b-relay.rig2")
    expect(rigd.healthRequests).toEqual([{ stateRoot: "/tmp/rig-v2" }])
    expect(rigd.inventoryRequests).toEqual([{ project: "pantry", stateRoot: "/tmp/rig-v2" }])
  })

  test("GIVEN rigd command WHEN running THEN local API start is requested", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "rigd",
      "--state-root",
      "/tmp/rig-v2",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(rigd.startRequests).toEqual([{ stateRoot: "/tmp/rig-v2" }])
  })

  test("GIVEN deploy command WHEN running THEN CLI deploy intent targets refs without semver", async () => {
    const { exitCode, logger, deployIntents } = await runWithLogger([
      "deploy",
      "--project",
      "pantry",
      "--state-root",
      "/tmp/rig-v2",
      "--ref",
      "feature/preview",
      "--target",
      "generated",
      "--deployment",
      "qa",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(deployIntents.cliDeploys).toEqual([
      {
        project: "pantry",
        stateRoot: "/tmp/rig-v2",
        ref: "feature/preview",
        target: "generated",
        deploymentName: "qa",
      },
    ])
    expect(logger.infos.at(-1)?.message).toBe("rig2 deploy intent")
  })

  test("GIVEN bump command WHEN running THEN optional version metadata is emitted", async () => {
    const { exitCode, logger, deployIntents } = await runWithLogger([
      "bump",
      "--project",
      "pantry",
      "--state-root",
      "/tmp/rig-v2",
      "--current",
      "1.2.3",
      "--bump",
      "minor",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(deployIntents.bumps).toEqual([
      {
        project: "pantry",
        currentVersion: "1.2.3",
        bump: "minor",
      },
    ])
    expect(logger.infos.at(-1)?.message).toBe("rig2 bump metadata")
  })

  test("GIVEN doctor command WHEN running THEN doctor report is emitted", async () => {
    const { exitCode, logger, doctor } = await runWithLogger([
      "doctor",
      "--project",
      "pantry",
      "--state-root",
      "/tmp/rig-v2",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(doctor.reports[0]).toMatchObject({
      project: "pantry",
      path: {
        ok: true,
        entries: ["/tmp/rig-v2"],
      },
      providers: expect.arrayContaining([
        expect.objectContaining({
          name: "localhost-http",
          profile: "default",
          details: expect.objectContaining({
            family: "control-plane-transport",
            source: "first-party",
          }),
        }),
      ]),
    })
    expect(logger.infos.at(-1)?.message).toBe("rig2 doctor report")
  })

  test("GIVEN up without project inside managed repo WHEN running THEN it infers project and targets local lane", async () => {
    const { exitCode, logger, lifecycle } = await runWithLogger(["up"], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(lifecycle.requests).toEqual([
      {
        action: "up",
        project: "pantry",
        lane: "local",
        stateRoot: expect.stringContaining(".rig-v2"),
      },
    ])
  })

  test("GIVEN logs with explicit project and live lane WHEN running THEN lifecycle request includes log options", async () => {
    const { exitCode, lifecycle } = await runWithLogger([
      "logs",
      "--project",
      "pantry",
      "--lane",
      "live",
      "--lines",
      "25",
      "--follow",
    ])

    expect(exitCode).toBe(0)
    expect(lifecycle.requests[0]).toMatchObject({
      action: "logs",
      project: "pantry",
      lane: "live",
      lines: 25,
      follow: true,
    })
  })

  test("GIVEN repo-first command outside managed repo WHEN project is omitted THEN it logs a tagged argument error", async () => {
    const { exitCode, logger, lifecycle } = await runWithLogger(["up"])

    expect(exitCode).toBe(1)
    expect(lifecycle.requests).toEqual([])
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]?._tag).toBe("V2CliArgumentError")
    expect(logger.errors[0]?.message).toContain("No rig.json")
  })

  test("GIVEN down destroy on local lane WHEN running THEN destroy is rejected as reserved", async () => {
    const { exitCode, logger, lifecycle } = await runWithLogger([
      "down",
      "--project",
      "pantry",
      "--destroy",
    ])

    expect(exitCode).toBe(1)
    expect(lifecycle.requests).toEqual([])
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]?.message).toContain("reserved for generated deployments")
  })

  test("GIVEN status command with invalid project WHEN running THEN schema failure is logged structurally", async () => {
    const { exitCode, logger } = await runWithLogger(["status", "--project", "../pantry"])

    expect(exitCode).toBe(1)
    expect(logger.infos).toEqual([])
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]?._tag).toBe("V2CliArgumentError")
    expect(logger.errors[0]?.details?.originalTag).toBe("V2ConfigValidationError")
  })
})
