import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runRigCli } from "./cli.js"
import type {
  V2ConfigApplyResult,
  V2ConfigPreviewInput,
  V2ConfigPreviewResult,
  V2ConfigReadInput,
  V2ConfigReadModel,
} from "./config-editor.js"
import type { V2ProjectConfig } from "./config.js"
import {
  V2DeployIntents,
  type V2BumpInput,
  type V2CliDeployInput,
  type V2GitPushDeployInput,
} from "./deploy-intent.js"
import { V2Doctor, type V2DoctorReportInput } from "./doctor.js"
import { V2CliArgumentError, type V2TaggedError } from "./errors.js"
import { V2Lifecycle, type V2LifecycleRequest } from "./lifecycle.js"
import { V2ProjectConfigLoader, type V2ProjectConfigLoadInput } from "./project-config-loader.js"
import {
  V2ProjectInitializer,
  type V2ProjectInitInput,
  type V2ProjectInitResult,
} from "./project-initializer.js"
import { V2ProjectLocator } from "./project-locator.js"
import { V2ProviderRegistryLive } from "./provider-contracts.js"
import {
  V2Rigd,
  type V2RigdControlPlaneDeployInput,
  type V2RigdDeployInput,
  type V2RigdHealthStateInput,
  type V2RigdProjectInventoryInput,
  type V2RigdStartInput,
  type V2RigdWebReadInput,
  type V2RigdWebReadModel,
} from "./rigd.js"
import { V2Logger, V2RuntimeLive } from "./services.js"

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

class CaptureV2ProjectInitializer {
  readonly requests: V2ProjectInitInput[] = []

  init(input: V2ProjectInitInput) {
    this.requests.push(input)
    return Effect.succeed({
      project: input.project,
      repoPath: input.path === "." ? "/tmp/repo" : input.path,
      configPath: `${input.path === "." ? "/tmp/repo" : input.path}/rig.json`,
      providerProfile: input.providerProfile,
      packageScripts: {
        requested: input.packageScripts ?? false,
        packageJsonPath: `${input.path === "." ? "/tmp/repo" : input.path}/package.json`,
        addedScripts: input.packageScripts ? ["rig:up", "rig:down"] : [],
      },
      scaffoldedComponents: input.componentPlugins ?? [],
    } satisfies V2ProjectInitResult)
  }
}

class CaptureV2Rigd {
  readonly configApplyRequests: V2ConfigPreviewInput[] = []
  readonly configPreviewRequests: V2ConfigPreviewInput[] = []
  readonly configReadRequests: V2ConfigReadInput[] = []
  readonly controlPlaneDeployRequests: V2RigdControlPlaneDeployInput[] = []
  readonly deployRequests: V2RigdDeployInput[] = []
  readonly healthRequests: V2RigdStartInput[] = []
  readonly healthStateRequests: V2RigdHealthStateInput[] = []
  readonly inventoryRequests: V2RigdProjectInventoryInput[] = []
  readonly startRequests: V2RigdStartInput[] = []
  readonly webReadModelRequests: V2RigdWebReadInput[] = []

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

  healthState(input: V2RigdHealthStateInput) {
    this.healthStateRequests.push(input)
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

  deploy(input: V2RigdDeployInput) {
    this.deployRequests.push(input)
    return Effect.succeed({
      id: "rigd-1",
      kind: "deploy" as const,
      accepted: true as const,
      project: input.project,
      stateRoot: input.stateRoot,
      target: input.target,
      receivedAt: "2026-04-24T00:00:00.000Z",
    })
  }

  controlPlaneDeploy(input: V2RigdControlPlaneDeployInput) {
    this.controlPlaneDeployRequests.push(input)
    return Effect.succeed({
      id: "rigd-1",
      kind: "deploy" as const,
      accepted: true as const,
      project: input.project,
      stateRoot: input.stateRoot,
      target: input.target,
      receivedAt: "2026-04-24T00:00:00.000Z",
    })
  }

  configRead(input: V2ConfigReadInput) {
    this.configReadRequests.push(input)
    return Effect.succeed({
      project: input.project,
      configPath: input.configPath,
      revision: "rev-1",
      raw: { name: input.project },
      config: {
        name: input.project,
        components: {},
      } as V2ProjectConfig,
      fields: [
        {
          path: ["live", "deployBranch"],
          valueShape: "string",
          description: "Live lane deploy branch.",
        },
      ],
    } satisfies V2ConfigReadModel)
  }

  webReadModel(input: V2RigdWebReadInput) {
    this.webReadModelRequests.push(input)
    return Effect.succeed({
      projects: [
        { name: "api" },
        { name: "pantry" },
      ],
      deployments: [
        {
          project: "api",
          name: "local",
          kind: "local" as const,
          providerProfile: "stub",
          observedAt: "2026-04-30T12:00:00.000Z",
        },
        {
          project: "pantry",
          name: "live",
          kind: "live" as const,
          providerProfile: "default",
          observedAt: "2026-04-30T12:01:00.000Z",
        },
      ],
      health: {
        rigd: {
          status: "running" as const,
          checkedAt: "2026-04-30T12:02:00.000Z",
          providerProfile: "default",
        },
        deployments: [],
        components: [],
        providers: [],
      },
    } satisfies V2RigdWebReadModel)
  }

  webLogs() {
    return Effect.die("unused")
  }

  configPreview(input: V2ConfigPreviewInput) {
    this.configPreviewRequests.push(input)
    return Effect.succeed(this.configEditResult(input))
  }

  configApply(input: V2ConfigPreviewInput) {
    this.configApplyRequests.push(input)
    return Effect.succeed({
      ...this.configEditResult(input),
      applied: true,
      backupPath: `${input.configPath}.backup-rev-1.json`,
    } satisfies V2ConfigApplyResult)
  }

  private configEditResult(input: V2ConfigPreviewInput): V2ConfigPreviewResult {
    return {
      project: input.project,
      configPath: input.configPath,
      baseRevision: input.expectedRevision,
      nextRevision: "rev-2",
      patch: input.patch,
      diff: input.patch.map((patch) => ({
        path: patch.path,
        before: patch.path.join(".") === "live.deployBranch" ? "main" : undefined,
        ...(patch.op === "set" ? { after: patch.value } : {}),
        description: "Live lane deploy branch.",
      })),
      raw: { name: input.project },
      config: {
        name: input.project,
        components: {},
      } as V2ProjectConfig,
    }
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

class CaptureV2ProjectConfigLoader {
  readonly loads: V2ProjectConfigLoadInput[] = []

  load(input: V2ProjectConfigLoadInput) {
    this.loads.push(input)
    return Effect.succeed({
      project: input.project,
      configPath: input.configPath,
      config: {
        name: input.project,
        components: {
          web: {
            mode: "managed" as const,
            command: "bun run start -- --port ${web.port}",
            port: 3070,
            health: "http://127.0.0.1:${web.port}/health",
          },
        },
        deployments: {
          providerProfile: "stub" as const,
        },
      } satisfies V2ProjectConfig,
    })
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
  const initializer = new CaptureV2ProjectInitializer()
  const rigd = new CaptureV2Rigd()
  const deployIntents = new CaptureV2DeployIntents()
  const doctor = new CaptureV2Doctor()
  const configLoader = new CaptureV2ProjectConfigLoader()
  const layer = Layer.mergeAll(
    V2RuntimeLive,
    Layer.succeed(V2Logger, logger),
    Layer.succeed(V2Lifecycle, lifecycle),
    Layer.succeed(V2ProjectInitializer, initializer),
    Layer.succeed(V2Rigd, rigd),
    Layer.succeed(V2DeployIntents, deployIntents),
    Layer.succeed(V2Doctor, doctor),
    Layer.succeed(V2ProjectConfigLoader, configLoader),
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
  const exitCode = await Effect.runPromise(runRigCli(argv).pipe(Effect.provide(layer)))

  return { exitCode, logger, lifecycle, initializer, rigd, deployIntents, doctor, configLoader }
}

describe("GIVEN rig Effect CLI foundation WHEN commands run THEN behavior is covered", () => {
  test("GIVEN init command WHEN running THEN it initializes a v2 project through the v2 initializer", async () => {
    const { exitCode, logger, initializer } = await runWithLogger([
      "init",
      "--project",
      "pantry",
      "--path",
      "/tmp/pantry",
      "--state-root",
      "/tmp/rig-v2",
      "--provider-profile",
      "stub",
      "--domain",
      "pantry.b-relay.com",
      "--proxy",
      "web",
      "--package-scripts",
      "--uses",
      "sqlite,postgres,convex",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(initializer.requests).toEqual([
      {
        project: "pantry",
        path: "/tmp/pantry",
        stateRoot: "/tmp/rig-v2",
        providerProfile: "stub",
        domain: "pantry.b-relay.com",
        proxy: "web",
        packageScripts: true,
        componentPlugins: ["sqlite", "postgres", "convex"],
      },
    ])
    expect(logger.infos).toEqual([
      {
        message: "rig project initialized",
        details: expect.objectContaining({
          project: "pantry",
          repoPath: "/tmp/pantry",
          configPath: "/tmp/pantry/rig.json",
          providerProfile: "stub",
        }),
      },
    ])
  })

  test("GIVEN init command with unknown uses plugin WHEN running THEN it reports a tagged argument error", async () => {
    const { exitCode, logger, initializer } = await runWithLogger([
      "init",
      "--project",
      "pantry",
      "--state-root",
      "/tmp/rig-v2",
      "--uses",
      "sqlite,nextjs",
    ])

    expect(exitCode).toBe(1)
    expect(initializer.requests).toEqual([])
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]).toEqual(expect.objectContaining({
      _tag: "V2CliArgumentError",
      message: "Unknown init component plugin 'nextjs'.",
    }))
  })

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
    expect(logger.infos[0]?.message).toBe([
      "rig foundation ready",
      "project: pantry",
      "lane: local",
      "state root: /tmp/rig-v2",
      "namespace: rig.v2.pantry",
      "launchd label prefix: com.b-relay.rig2",
    ].join("\n"))
    expect(logger.infos[0]?.details).toBeUndefined()
    expect(logger.infos[1]?.message).toBe([
      "rigd status",
      "rigd: running",
      "project: pantry",
      "deployments: 0",
    ].join("\n"))
    expect(logger.infos[1]?.details).toBeUndefined()
    expect(rigd.healthRequests).toEqual([{ stateRoot: "/tmp/rig-v2" }])
    expect(rigd.inventoryRequests).toEqual([{ project: "pantry", stateRoot: "/tmp/rig-v2" }])
  })

  test("GIVEN status command with json WHEN running THEN structured details are emitted alongside readable output", async () => {
    const { exitCode, logger, lifecycle } = await runWithLogger([
      "status",
      "--project",
      "pantry",
      "--state-root",
      "/tmp/rig-v2",
      "--json",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(logger.infos.map((entry) => entry.message)).toEqual([
      expect.stringContaining("rig foundation ready"),
      "rig foundation details",
      expect.stringContaining("rigd status"),
      "rigd status details",
    ])
    expect(logger.infos[1]?.details).toMatchObject({
      project: "pantry",
      stateRoot: "/tmp/rig-v2",
      namespace: "rig.v2.pantry",
    })
    expect(logger.infos[3]?.details).toMatchObject({
      health: {
        status: "running",
      },
      inventory: {
        project: "pantry",
        deploymentCount: 0,
      },
    })
    expect(lifecycle.requests[0]).toMatchObject({
      action: "status",
      project: "pantry",
      structured: true,
    })
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

  test("GIVEN list command WHEN running THEN it renders projects and deployments from rigd", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "list",
      "--state-root",
      "/tmp/rig-v2",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(rigd.webReadModelRequests).toEqual([{ stateRoot: "/tmp/rig-v2" }])
    expect(logger.infos).toEqual([
      {
        message: [
          "rig projects",
          "rigd: running",
          "projects:",
          "  api",
          "  pantry",
          "deployments:",
          "  api/local (local) profile=stub observed=2026-04-30T12:00:00.000Z",
          "  pantry/live (live) profile=default observed=2026-04-30T12:01:00.000Z",
        ].join("\n"),
        details: undefined,
      },
    ])
  })

  test("GIVEN list json command WHEN running THEN it emits the structured rigd read model", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "list",
      "--state-root",
      "/tmp/rig-v2",
      "--json",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(rigd.webReadModelRequests).toEqual([{ stateRoot: "/tmp/rig-v2" }])
    expect(logger.infos.map((entry) => entry.message)).toEqual([
      expect.stringContaining("rig projects"),
      "rig projects details",
    ])
    expect(logger.infos[1]?.details).toMatchObject({
      projects: [
        { name: "api" },
        { name: "pantry" },
      ],
      deployments: expect.arrayContaining([
        expect.objectContaining({
          project: "api",
          name: "local",
          kind: "local",
        }),
      ]),
      health: {
        rigd: {
          status: "running",
        },
      },
    })
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
    expect(logger.infos.at(-1)?.message).toBe("rig deploy intent")
  })

  test("GIVEN deploy inside managed repo WHEN running THEN config is loaded and accepted by rigd", async () => {
    const { exitCode, logger, deployIntents, rigd, configLoader } = await runWithLogger([
      "deploy",
      "--ref",
      "feature/preview",
      "--target",
      "generated",
    ], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(configLoader.loads).toEqual([
      {
        project: "pantry",
        configPath: "/tmp/repo/rig.json",
      },
    ])
    expect(deployIntents.cliDeploys[0]).toMatchObject({
      project: "pantry",
      ref: "feature/preview",
      target: "generated",
      config: expect.objectContaining({
        name: "pantry",
      }),
    })
    expect(rigd.deployRequests).toEqual([
      expect.objectContaining({
        project: "pantry",
        ref: "feature/preview",
        target: "generated",
        config: expect.objectContaining({
          name: "pantry",
        }),
      }),
    ])
    expect(rigd.controlPlaneDeployRequests).toEqual([])
    expect(logger.infos.map((entry) => entry.message)).toContain("rig deploy accepted")
  })

  test("GIVEN explicit project with config path WHEN running up THEN it loads that config", async () => {
    const { exitCode, lifecycle, configLoader } = await runWithLogger([
      "up",
      "--project",
      "pantry",
      "--config",
      "/tmp/pantry/rig.json",
    ])

    expect(exitCode).toBe(0)
    expect(configLoader.loads).toEqual([
      {
        project: "pantry",
        configPath: "/tmp/pantry/rig.json",
      },
    ])
    expect(lifecycle.requests[0]).toMatchObject({
      action: "up",
      project: "pantry",
      config: expect.objectContaining({
        name: "pantry",
      }),
    })
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
    expect(logger.infos.at(-1)?.message).toBe("rig bump metadata")
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
    expect(logger.infos.at(-1)?.message).toBe("rig doctor report")
  })

  test("GIVEN config read inside managed repo WHEN running THEN rigd returns editor-ready config details", async () => {
    const { exitCode, logger, rigd } = await runWithLogger(["config", "read"], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(rigd.configReadRequests).toEqual([
      {
        project: "pantry",
        configPath: "/tmp/repo/rig.json",
      },
    ])
    expect(logger.infos.at(-1)).toMatchObject({
      message: "rig config read",
      details: expect.objectContaining({
        project: "pantry",
        revision: "rev-1",
        fieldCount: 1,
      }),
    })
  })

  test("GIVEN config set preview WHEN running THEN rigd previews a structured patch without applying", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "config",
      "set",
      "--project",
      "pantry",
      "--config",
      "/tmp/pantry/rig.json",
      "--path",
      "live.deployBranch",
      "--json",
      "\"stable\"",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(rigd.configPreviewRequests).toEqual([
      {
        project: "pantry",
        configPath: "/tmp/pantry/rig.json",
        expectedRevision: "rev-1",
        patch: [
          {
            op: "set",
            path: ["live", "deployBranch"],
            value: "stable",
          },
        ],
      },
    ])
    expect(rigd.configApplyRequests).toEqual([])
    expect(logger.infos.at(-1)?.message).toBe("rig config preview")
  })

  test("GIVEN config unset apply WHEN running THEN rigd applies a remove patch", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "config",
      "unset",
      "--project",
      "pantry",
      "--config",
      "/tmp/pantry/rig.json",
      "--path",
      "live.deployBranch",
      "--apply",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(rigd.configApplyRequests).toEqual([
      {
        project: "pantry",
        configPath: "/tmp/pantry/rig.json",
        expectedRevision: "rev-1",
        patch: [
          {
            op: "remove",
            path: ["live", "deployBranch"],
          },
        ],
      },
    ])
    expect(logger.infos.at(-1)).toMatchObject({
      message: "rig config applied",
      details: expect.objectContaining({
        backupPath: "/tmp/pantry/rig.json.backup-rev-1.json",
      }),
    })
  })

  test("GIVEN up without project inside managed repo WHEN running THEN it loads config and targets local lane", async () => {
    const { exitCode, logger, lifecycle, configLoader } = await runWithLogger(["up"], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(configLoader.loads).toEqual([
      {
        project: "pantry",
        configPath: "/tmp/repo/rig.json",
      },
    ])
    expect(lifecycle.requests).toEqual([
      {
        action: "up",
        project: "pantry",
        lane: "local",
        stateRoot: expect.stringContaining(".rig-v2"),
        config: expect.objectContaining({
          name: "pantry",
        }),
      },
    ])
  })

  test("GIVEN restart with explicit project WHEN running THEN lifecycle receives restart with config", async () => {
    const { exitCode, logger, lifecycle, configLoader } = await runWithLogger([
      "restart",
      "--project",
      "pantry",
      "--config",
      "/tmp/pantry/rig.json",
      "--lane",
      "live",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(configLoader.loads).toEqual([
      {
        project: "pantry",
        configPath: "/tmp/pantry/rig.json",
      },
    ])
    expect(lifecycle.requests).toEqual([
      {
        action: "restart",
        project: "pantry",
        lane: "live",
        stateRoot: expect.stringContaining(".rig-v2"),
        config: expect.objectContaining({
          name: "pantry",
        }),
      },
    ])
  })

  test("GIVEN status inside managed repo WHEN running THEN inventory and health use config", async () => {
    const { exitCode, rigd, lifecycle, configLoader } = await runWithLogger(["status"], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(0)
    expect(configLoader.loads).toEqual([
      {
        project: "pantry",
        configPath: "/tmp/repo/rig.json",
      },
    ])
    expect(rigd.inventoryRequests[0]).toMatchObject({
      project: "pantry",
      config: expect.objectContaining({
        name: "pantry",
      }),
    })
    expect(lifecycle.requests[0]).toMatchObject({
      action: "status",
      project: "pantry",
      config: expect.objectContaining({
        name: "pantry",
      }),
    })
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
