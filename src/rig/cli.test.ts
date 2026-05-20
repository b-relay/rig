import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { runRigCli } from "./cli.js"
import type {
  RigConfigApplyResult,
  RigConfigPreviewInput,
  RigConfigPreviewResult,
  RigConfigReadInput,
  RigConfigReadModel,
} from "./config-editor.js"
import type { RigProjectConfig } from "./config.js"
import {
  RigDeployIntents,
  type RigBumpInput,
  type RigCliDeployInput,
  type RigGitPushDeployInput,
} from "./deploy-intent.js"
import type { RigDeploymentRecord } from "./deployments.js"
import { RigDoctor, type RigDoctorReportInput } from "./doctor.js"
import {
  RigdDaemonAdmin,
  type RigdDaemonAdminInput,
} from "./daemon-admin.js"
import { RigCliArgumentError, type RigTaggedError } from "./errors.js"
import { RigGitWorkspace, type RigGitUpstreamStatus } from "./git-workspace.js"
import {
  RigHomeConfigStore,
  rigHomeConfigDefaults,
  type RigHomeConfigReadInput,
  type RigHomeConfigWriteInput,
} from "./home-config.js"
import { RigLifecycle, type RigLifecycleRequest } from "./lifecycle.js"
import { RigProjectConfigLoader, type RigProjectConfigLoadInput } from "./project-config-loader.js"
import {
  RigProjectInitializer,
  type RigProjectInitInput,
  type RigProjectInitResult,
} from "./project-initializer.js"
import { RigProjectLocator } from "./project-locator.js"
import { RigProviderRegistryLive } from "./provider-contracts.js"
import {
  Rigd,
  type RigdControlPlaneDeployInput,
  type RigdDeployInput,
  type RigdGitPushDeployInput,
  type RigdHealthStateInput,
  type RigdProjectInventoryInput,
  type RigdStartInput,
  type RigdWebReadInput,
  type RigdWebReadModel,
} from "./rigd.js"
import { RigLogger, RigRuntimeLive } from "./services.js"

class CaptureRigLogger {
  readonly infos: Array<{ readonly message: string; readonly details?: unknown }> = []
  readonly errors: RigTaggedError[] = []

  info(message: string, details?: unknown) {
    this.infos.push({ message, details })
    return Effect.void
  }

  error(error: RigTaggedError) {
    this.errors.push(error)
    return Effect.void
  }
}

class CaptureRigLifecycle {
  readonly requests: RigLifecycleRequest[] = []

  run(request: RigLifecycleRequest) {
    this.requests.push(request)
    return Effect.void
  }
}

class CaptureRigProjectInitializer {
  readonly requests: RigProjectInitInput[] = []

  init(input: RigProjectInitInput) {
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
    } satisfies RigProjectInitResult)
  }
}

class CaptureRigd {
  readonly configApplyRequests: RigConfigPreviewInput[] = []
  readonly configPreviewRequests: RigConfigPreviewInput[] = []
  readonly configReadRequests: RigConfigReadInput[] = []
  readonly controlPlaneDeployRequests: RigdControlPlaneDeployInput[] = []
  readonly deployRequests: RigdDeployInput[] = []
  readonly gitPushDeployRequests: RigdGitPushDeployInput[] = []
  readonly healthRequests: RigdStartInput[] = []
  readonly healthStateRequests: RigdHealthStateInput[] = []
  readonly inventoryRequests: RigdProjectInventoryInput[] = []
  readonly startRequests: RigdStartInput[] = []
  readonly webReadModelRequests: RigdWebReadInput[] = []

  start(input: RigdStartInput) {
    this.startRequests.push(input)
    return Effect.succeed({
      service: "rigd" as const,
      status: "running" as const,
      stateRoot: input.stateRoot,
      startedAt: "2026-04-24T00:00:00.000Z",
      localApi: {
        transport: "in-process" as const,
        version: "rig-mvp" as const,
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

  health(input: RigdStartInput) {
    this.healthRequests.push(input)
    return this.start(input)
  }

  inventory(input: RigdProjectInventoryInput) {
    this.inventoryRequests.push(input)
    return Effect.succeed({
      project: input.project,
      foundation: {
        project: input.project,
        namespace: `rig.rig.${input.project}`,
        stateRoot: input.stateRoot,
        registryPath: `${input.stateRoot}/registry.json`,
        workspacesRoot: `${input.stateRoot}/workspaces`,
        projectWorkspaceRoot: `${input.stateRoot}/workspaces/${input.project}`,
        logsRoot: `${input.stateRoot}/logs`,
        projectLogRoot: `${input.stateRoot}/logs/${input.project}`,
        runtimeRoot: `${input.stateRoot}/runtime`,
        runtimeStatePath: `${input.stateRoot}/runtime/runtime.json`,
        binRoot: `${input.stateRoot}/bin`,
        proxyRoot: `${input.stateRoot}/proxy`,
        proxyNamespace: "rig",
        launchdLabelPrefix: "com.b-relay.rig",
        launchdBackupRoot: `${input.stateRoot}/launchd`,
      },
      deployments: input.project === "pantry"
        ? [
          deploymentRecord({
            project: "pantry",
            kind: "local",
            name: "local",
            port: 3070,
          }),
          deploymentRecord({
            project: "pantry",
            kind: "live",
            name: "live",
            port: 4070,
            sourceRef: "main",
          }),
        ]
        : [],
    })
  }

  logs() {
    return Effect.succeed([])
  }

  healthState(input: RigdHealthStateInput) {
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

  deploy(input: RigdDeployInput) {
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

  gitPushDeploy(input: RigdGitPushDeployInput) {
    this.gitPushDeployRequests.push(input)
    return Effect.succeed({
      id: "rigd-1",
      kind: "deploy" as const,
      accepted: true as const,
      project: input.project,
      stateRoot: input.stateRoot,
      target: input.destinationBranch,
      receivedAt: "2026-04-24T00:00:00.000Z",
    })
  }

  controlPlaneDeploy(input: RigdControlPlaneDeployInput) {
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

  configRead(input: RigConfigReadInput) {
    this.configReadRequests.push(input)
    return Effect.succeed({
      project: input.project,
      configPath: input.configPath,
      revision: "rev-1",
      raw: { name: input.project },
      config: {
        name: input.project,
        components: {},
      } as RigProjectConfig,
      fields: [
        {
          path: ["live", "deployBranch"],
          valueShape: "string",
          description: "Live lane deploy branch.",
        },
      ],
    } satisfies RigConfigReadModel)
  }

  webReadModel(input: RigdWebReadInput) {
    this.webReadModelRequests.push(input)
    return Effect.succeed({
      projects: [
        { name: "api", repoPath: "/tmp/api", configPath: "/tmp/api/rig.json", targetCount: 1 },
        { name: "pantry", repoPath: "/tmp/repo", configPath: "/tmp/repo/rig.json", targetCount: 2 },
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
          name: "local",
          kind: "local" as const,
          providerProfile: "default",
          observedAt: "2026-04-30T12:01:00.000Z",
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
    } satisfies RigdWebReadModel)
  }

  webLogs() {
    return Effect.die("unused")
  }

  configPreview(input: RigConfigPreviewInput) {
    this.configPreviewRequests.push(input)
    return Effect.succeed(this.configEditResult(input))
  }

  configApply(input: RigConfigPreviewInput) {
    this.configApplyRequests.push(input)
    return Effect.succeed({
      ...this.configEditResult(input),
      applied: true,
      backupPath: `${input.configPath}.backup-rev-1.json`,
    } satisfies RigConfigApplyResult)
  }

  private configEditResult(input: RigConfigPreviewInput): RigConfigPreviewResult {
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
      } as RigProjectConfig,
    }
  }
}

const deploymentRecord = (input: {
  readonly project: string
  readonly kind: RigDeploymentRecord["kind"]
  readonly name: string
  readonly port: number
  readonly sourceRef?: string
}): RigDeploymentRecord => ({
  project: input.project,
  kind: input.kind,
  name: input.name,
  ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
  branchSlug: input.name,
  subdomain: input.name,
  workspacePath: `/tmp/rig/workspaces/${input.project}/${input.name}`,
  dataRoot: `/tmp/rig/data/${input.project}/${input.name}`,
  logRoot: `/tmp/rig/logs/${input.project}/${input.name}`,
  runtimeRoot: `/tmp/rig/runtime/${input.project}/${input.name}`,
  runtimeStatePath: `/tmp/rig/runtime/${input.project}/${input.name}/state.json`,
  assignedPorts: { web: input.port },
  providerProfile: "default",
  resolved: {
    project: input.project,
    lane: input.kind === "generated" ? "deployments" : input.kind,
    deploymentName: input.name,
    branchSlug: input.name,
    subdomain: input.name,
    workspacePath: `/tmp/rig/workspaces/${input.project}/${input.name}`,
    dataRoot: `/tmp/rig/data/${input.project}/${input.name}`,
    providerProfile: "default",
    providers: {},
    preparedComponents: [],
    runtimePlan: { components: [] },
    environment: {
      project: input.project,
      lane: input.kind === "generated" ? "deployments" : input.kind,
      deploymentName: input.name,
      variables: {},
    },
    v1Config: {},
  } as RigDeploymentRecord["resolved"],
})

class CaptureRigdDaemonAdmin {
  readonly statusRequests: RigdDaemonAdminInput[] = []

  install() {
    return Effect.die("unused")
  }

  status(input: RigdDaemonAdminInput) {
    this.statusRequests.push(input)
    return Effect.succeed({
      stateRoot: input.stateRoot,
      installed: true,
      running: true,
      reachable: true,
      tokenPath: `${input.stateRoot}/auth/control-plane.token`,
      tokenPresent: true,
      daemonStatePath: `${input.stateRoot}/daemon/rigd.json`,
    })
  }

  uninstall() {
    return Effect.die("unused")
  }
}

class CaptureRigDeployIntents {
  readonly cliDeploys: RigCliDeployInput[] = []
  readonly bumps: RigBumpInput[] = []

  fromGitPush(_input: RigGitPushDeployInput) {
    return Effect.die("unused")
  }

  fromCliDeploy(input: RigCliDeployInput) {
    this.cliDeploys.push(input)
    return Effect.succeed({
      source: "cli" as const,
      project: input.project,
      stateRoot: input.stateRoot,
      ref: input.ref,
      ...(input.commit ? { commit: input.commit } : {}),
      target: input.target,
      lane: input.target === "live" ? "live" as const : "deployment" as const,
      ...(input.deploymentName ? { deploymentName: input.deploymentName } : {}),
    })
  }

  bump(input: RigBumpInput) {
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

class CaptureRigGitWorkspace {
  readonly currentBranchRequests: string[] = []
  readonly branchCommitRequests: Array<{ readonly repoPath: string; readonly branch: string }> = []
  readonly branchExistsRequests: Array<{ readonly repoPath: string; readonly branch: string }> = []
  readonly upstreamStatusRequests: Array<{ readonly repoPath: string; readonly branch: string }> = []

  constructor(
    private readonly options: {
      readonly currentBranch?: string
      readonly detached?: boolean
      readonly missingBranches?: readonly string[]
      readonly upstreamStatus?: RigGitUpstreamStatus
    } = {},
  ) {}

  currentBranch(repoPath: string) {
    this.currentBranchRequests.push(repoPath)
    if (this.options.detached) {
      return Effect.fail(
        new RigCliArgumentError(
          "Cannot deploy preview from detached HEAD.",
          "Check out a local Branch, or pass an explicit Branch such as 'rig deploy preview feature/name'.",
        ),
      )
    }
    return Effect.succeed(this.options.currentBranch ?? "feature/current")
  }

  branchCommit(repoPath: string, branch: string) {
    this.branchCommitRequests.push({ repoPath, branch })
    return Effect.succeed(`commit-${branch.replace(/[^a-z0-9]/gi, "-")}`)
  }

  branchExists(repoPath: string, branch: string) {
    this.branchExistsRequests.push({ repoPath, branch })
    return Effect.succeed(!(this.options.missingBranches ?? []).includes(branch))
  }

  upstreamStatus(repoPath: string, branch: string) {
    this.upstreamStatusRequests.push({ repoPath, branch })
    return Effect.succeed(this.options.upstreamStatus ?? { ahead: 0, behind: 0 })
  }
}

class CaptureRigDoctor {
  readonly reports: RigDoctorReportInput[] = []

  preflight() {
    return Effect.die("unused")
  }

  report(input: RigDoctorReportInput) {
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
      diagnostics: [],
    })
  }

  reconstruct() {
    return Effect.die("unused")
  }
}

class CaptureRigHomeConfigStore {
  readonly reads: RigHomeConfigReadInput[] = []

  read(input: RigHomeConfigReadInput) {
    this.reads.push(input)
    return Effect.succeed(rigHomeConfigDefaults)
  }

  write(_input: RigHomeConfigWriteInput) {
    return Effect.die("unused")
  }
}

class CaptureRigProjectConfigLoader {
  readonly loads: RigProjectConfigLoadInput[] = []

  constructor(
    private readonly options: {
      readonly shouldFail?: boolean
      readonly liveDeployBranch?: string
    } = {},
  ) {}

  load(input: RigProjectConfigLoadInput) {
    this.loads.push(input)
    if (this.options.shouldFail) {
      return Effect.fail(
        new RigCliArgumentError(
          `Unable to load rig config for '${input.project}'.`,
          "Run from a repo with a valid rig.json before using rig runtime commands.",
          { project: input.project, configPath: input.configPath },
        ),
      )
    }
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
        live: {
          deployBranch: this.options.liveDeployBranch ?? "main",
        },
      } satisfies RigProjectConfig,
    })
  }
}

const runWithLogger = async (
  argv: readonly string[],
  options: {
    readonly inferredProject?: string
    readonly configLoadFails?: boolean
    readonly currentBranch?: string
    readonly detached?: boolean
    readonly liveDeployBranch?: string
    readonly missingBranches?: readonly string[]
    readonly upstreamStatus?: RigGitUpstreamStatus
  } = {},
) => {
  const logger = new CaptureRigLogger()
  const lifecycle = new CaptureRigLifecycle()
  const initializer = new CaptureRigProjectInitializer()
  const rigd = new CaptureRigd()
  const daemonAdmin = new CaptureRigdDaemonAdmin()
  const git = new CaptureRigGitWorkspace({
    currentBranch: options.currentBranch,
    detached: options.detached,
    missingBranches: options.missingBranches,
    upstreamStatus: options.upstreamStatus,
  })
  const deployIntents = new CaptureRigDeployIntents()
  const doctor = new CaptureRigDoctor()
  const homeConfigStore = new CaptureRigHomeConfigStore()
  const configLoader = new CaptureRigProjectConfigLoader({
    shouldFail: options.configLoadFails,
    liveDeployBranch: options.liveDeployBranch,
  })
  const layer = Layer.mergeAll(
    RigRuntimeLive,
    Layer.succeed(RigLogger, logger),
    Layer.succeed(RigLifecycle, lifecycle),
    Layer.succeed(RigProjectInitializer, initializer),
    Layer.succeed(Rigd, rigd),
    Layer.succeed(RigdDaemonAdmin, daemonAdmin),
    Layer.succeed(RigGitWorkspace, git),
    Layer.succeed(RigDeployIntents, deployIntents),
    Layer.succeed(RigDoctor, doctor),
    Layer.succeed(RigHomeConfigStore, homeConfigStore),
    Layer.succeed(RigProjectConfigLoader, configLoader),
    RigProviderRegistryLive("default"),
    Layer.succeed(RigProjectLocator, {
      inferCurrentProject: options.inferredProject
        ? Effect.succeed({
          name: options.inferredProject,
          repoPath: "/tmp/repo",
          configPath: "/tmp/repo/rig.json",
        })
        : Effect.fail(
          new RigCliArgumentError(
            "No rig.json found in the current directory.",
            "Run the command from a managed repo or pass --project <name> explicitly.",
          ),
        ),
    }),
  )
  const exitCode = await Effect.runPromise(runRigCli(argv).pipe(Effect.provide(layer)))

  return { exitCode, logger, lifecycle, initializer, rigd, daemonAdmin, git, deployIntents, doctor, homeConfigStore, configLoader }
}

describe("GIVEN rig Effect CLI foundation WHEN commands run THEN behavior is covered", () => {
  test("GIVEN init command WHEN running THEN it initializes a rig project through the rig initializer", async () => {
    const { exitCode, logger, initializer } = await runWithLogger([
      "init",
      "--project",
      "pantry",
      "--path",
      "/tmp/pantry",
      "--domain",
      "pantry.b-relay.com",
      "--proxy",
      "web",
      "--uses",
      "sqlite,postgres,convex",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(initializer.requests).toEqual([
      {
        project: "pantry",
        path: "/tmp/pantry",
        stateRoot: expect.stringContaining(".rig"),
        providerProfile: "default",
        domain: "pantry.b-relay.com",
        proxy: "web",
        packageScripts: false,
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
          providerProfile: "default",
        }),
      },
    ])
  })

  test("GIVEN init command with unknown uses plugin WHEN running THEN it reports a tagged argument error", async () => {
    const { exitCode, logger, initializer } = await runWithLogger([
      "init",
      "--project",
      "pantry",
      "--uses",
      "sqlite,nextjs",
    ])

    expect(exitCode).toBe(1)
    expect(initializer.requests).toEqual([])
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]).toEqual(expect.objectContaining({
      _tag: "RigCliArgumentError",
      message: "Unknown init component plugin 'nextjs'.",
    }))
  })

  test("GIVEN status command with project WHEN running THEN it reports all project targets", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "status",
      "--project",
      "pantry",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(logger.infos).toHaveLength(2)
    expect(logger.infos[0]?.message).toContain("rig foundation ready")
    expect(logger.infos[0]?.message).toContain("project: pantry")
    expect(logger.infos[0]?.message).toContain("lane: local")
    expect(logger.infos[0]?.message).toContain("state root:")
    expect(logger.infos[0]?.message).toContain("namespace: rig.pantry")
    expect(logger.infos[0]?.message).toContain("launchd label prefix: com.b-relay.rig")
    expect(logger.infos[0]?.details).toBeUndefined()
    expect(logger.infos[1]?.message).toBe([
      "rig project status",
      "rigd: running",
      "project: pantry",
      "targets:",
      "  local (local) profile=default ports=web:3070 ref=working-copy",
      "  live (live) profile=default ports=web:4070 ref=main",
    ].join("\n"))
    expect(logger.infos[1]?.details).toBeUndefined()
    expect(rigd.healthRequests).toEqual([{ stateRoot: expect.stringContaining(".rig") }])
    expect(rigd.inventoryRequests).toEqual([{ project: "pantry", stateRoot: expect.stringContaining(".rig") }])
    expect(rigd.webReadModelRequests).toEqual([{ stateRoot: expect.stringContaining(".rig") }])
  })

  test("GIVEN status for an unknown project WHEN running THEN it fails before reading stale local state", async () => {
    const { exitCode, logger, rigd, lifecycle } = await runWithLogger([
      "status",
      "--project",
      "missing",
    ])

    expect(exitCode).toBe(1)
    expect(logger.errors[0]).toEqual(expect.objectContaining({
      _tag: "RigCliArgumentError",
      message: "Project 'missing' is not registered with rigd.",
    }))
    expect(rigd.inventoryRequests).toEqual([])
    expect(lifecycle.requests).toEqual([])
  })

  test("GIVEN removed normal commands and flags WHEN running THEN they are rejected", async () => {
    const bump = await runWithLogger(["bump"])
    expect(bump.exitCode).toBe(1)
    expect(bump.deployIntents.bumps).toEqual([])

    const rigd = await runWithLogger(["rigd"])
    expect(rigd.exitCode).toBe(1)
    expect(rigd.rigd.startRequests).toEqual([])

    const json = await runWithLogger(["status", "--project", "pantry", "--json"])
    expect(json.exitCode).toBe(1)
    expect(json.logger.errors[0]?._tag).toBe("RigCliArgumentError")
  })

  test("GIVEN list command WHEN running THEN it renders Host project summaries from rigd", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "list",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(rigd.webReadModelRequests).toEqual([{ stateRoot: expect.stringContaining(".rig") }])
    expect(logger.infos).toEqual([
      {
        message: [
          "rig projects",
          "rigd: running",
          "projects:",
          "  api targets=1",
          "  pantry targets=2",
        ].join("\n"),
        details: undefined,
      },
    ])
  })

  test("GIVEN preview deploy command WHEN running inside a managed repo THEN CLI deploy intent targets Branches without semver", async () => {
    const { exitCode, logger, deployIntents, rigd } = await runWithLogger([
      "deploy",
      "preview",
      "feature/preview",
      "--deployment",
      "qa",
    ], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(deployIntents.cliDeploys).toEqual([
      {
        project: "pantry",
        stateRoot: expect.stringContaining(".rig"),
        ref: "feature/preview",
        commit: "commit-feature-preview",
        target: "generated",
        config: expect.objectContaining({
          name: "pantry",
        }),
        deploymentName: "qa",
      },
    ])
    expect(rigd.deployRequests).toEqual([
      expect.objectContaining({
        project: "pantry",
        stateRoot: expect.stringContaining(".rig"),
        ref: "feature/preview",
        commit: "commit-feature-preview",
        target: "generated",
        force: false,
        noUp: false,
        config: expect.objectContaining({
          name: "pantry",
        }),
        deploymentName: "qa",
      }),
    ])
    expect(logger.infos.map((entry) => entry.message)).toEqual([
      "rig deploy intent",
      "rig deploy accepted",
    ])
  })

  test("GIVEN deploy inside managed repo WHEN running THEN config is loaded and accepted by rigd", async () => {
    const { exitCode, logger, deployIntents, rigd, configLoader } = await runWithLogger([
      "deploy",
      "preview",
      "feature/preview",
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
      commit: "commit-feature-preview",
      target: "generated",
      config: expect.objectContaining({
        name: "pantry",
      }),
    })
    expect(rigd.deployRequests).toEqual([
      expect.objectContaining({
        project: "pantry",
        ref: "feature/preview",
        commit: "commit-feature-preview",
        target: "generated",
        config: expect.objectContaining({
          name: "pantry",
        }),
      }),
    ])
    expect(rigd.controlPlaneDeployRequests).toEqual([])
    expect(logger.infos.map((entry) => entry.message)).toContain("rig deploy accepted")
  })

  test("GIVEN live deploy without branch WHEN running THEN it deploys the configured Production Branch", async () => {
    const { exitCode, logger, deployIntents, rigd, git } = await runWithLogger([
      "deploy",
      "live",
      "--force",
      "--no-up",
    ], {
      inferredProject: "pantry",
      liveDeployBranch: "stable",
    })

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(deployIntents.cliDeploys[0]).toMatchObject({
      project: "pantry",
      ref: "stable",
      commit: "commit-stable",
      target: "live",
    })
    expect(rigd.deployRequests[0]).toMatchObject({
      project: "pantry",
      ref: "stable",
      commit: "commit-stable",
      target: "live",
      force: true,
      noUp: true,
    })
    expect(git.currentBranchRequests).toEqual([])
    expect(git.branchCommitRequests).toEqual([{ repoPath: "/tmp/repo", branch: "stable" }])
  })

  test("GIVEN live deploy with non-production branch WHEN running THEN it is rejected", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "deploy",
      "live",
      "feature/wrong",
    ], {
      inferredProject: "pantry",
      liveDeployBranch: "stable",
    })

    expect(exitCode).toBe(1)
    expect(rigd.deployRequests).toEqual([])
    expect(logger.errors[0]).toEqual(expect.objectContaining({
      _tag: "RigCliArgumentError",
      message: "Cannot deploy Branch 'feature/wrong' to the Stable Target.",
    }))
  })

  test("GIVEN live deploy with Preview deployment name WHEN running THEN it is rejected", async () => {
    const { exitCode, logger, deployIntents, rigd } = await runWithLogger([
      "deploy",
      "live",
      "--deployment",
      "qa",
    ], {
      inferredProject: "pantry",
      liveDeployBranch: "stable",
    })

    expect(exitCode).toBe(1)
    expect(deployIntents.cliDeploys).toEqual([])
    expect(rigd.deployRequests).toEqual([])
    expect(logger.errors[0]?._tag).toBe("RigCliArgumentError")
    expect(logger.errors[0]?.message).toBe("Stable deploys do not accept a Preview deployment name.")
    expect(logger.errors[0]?.details).toMatchObject({
      originalTag: "RigCliArgumentError",
      originalDetails: {
        reason: "stable-deployment-name",
        target: "live",
        deploymentName: "qa",
      },
    })
  })

  test("GIVEN preview deploy without branch WHEN running THEN it deploys the current Branch", async () => {
    const { exitCode, deployIntents, git } = await runWithLogger([
      "deploy",
      "preview",
    ], {
      inferredProject: "pantry",
      currentBranch: "feature/current",
    })

    expect(exitCode).toBe(0)
    expect(deployIntents.cliDeploys[0]).toMatchObject({
      ref: "feature/current",
      commit: "commit-feature-current",
      target: "generated",
    })
    expect(git.currentBranchRequests).toEqual(["/tmp/repo"])
  })

  test("GIVEN preview deploy from detached HEAD WHEN branch omitted THEN it fails with guidance", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "deploy",
      "preview",
    ], {
      inferredProject: "pantry",
      detached: true,
    })

    expect(exitCode).toBe(1)
    expect(rigd.deployRequests).toEqual([])
    expect(logger.errors[0]?.message).toBe("Cannot deploy preview from detached HEAD.")
  })

  test("GIVEN preview deploy of Production Branch WHEN running THEN it is rejected", async () => {
    const { exitCode, logger, rigd } = await runWithLogger([
      "deploy",
      "preview",
      "main",
    ], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(1)
    expect(rigd.deployRequests).toEqual([])
    expect(logger.errors[0]).toEqual(expect.objectContaining({
      _tag: "RigCliArgumentError",
      message: "Cannot deploy Production Branch 'main' as a Preview.",
      hint: "Create a Preview Branch such as 'preview/main' and deploy that Branch instead.",
    }))
  })

  test("GIVEN deploy branch differs from upstream WHEN running THEN it logs a non-fetching git warning", async () => {
    const { exitCode, logger } = await runWithLogger([
      "deploy",
      "preview",
      "feature/ahead",
    ], {
      inferredProject: "pantry",
      upstreamStatus: {
        upstream: "origin/feature/ahead",
        ahead: 2,
        behind: 1,
      },
    })

    expect(exitCode).toBe(0)
    expect(logger.infos).toContainEqual({
      message: "rig deploy git warning",
      details: expect.objectContaining({
        branch: "feature/ahead",
        upstream: "origin/feature/ahead",
        ahead: 2,
        behind: 1,
      }),
    })
  })

  test("GIVEN explicit config path flag WHEN running up THEN normal CLI rejects it", async () => {
    const { exitCode, lifecycle, configLoader, logger } = await runWithLogger([
      "up",
      "--project",
      "pantry",
      "--config",
      "/tmp/pantry/rig.json",
    ])

    expect(exitCode).toBe(1)
    expect(configLoader.loads).toEqual([])
    expect(lifecycle.requests).toEqual([])
    expect(logger.errors[0]?._tag).toBe("RigCliArgumentError")
  })

  test("GIVEN doctor command WHEN running THEN doctor report is emitted", async () => {
    const { exitCode, logger, doctor, daemonAdmin } = await runWithLogger([
      "doctor",
      "--project",
      "pantry",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(doctor.reports[0]).toMatchObject({
      project: "pantry",
      path: {
        ok: true,
        entries: [expect.stringContaining(".rig")],
      },
      providers: expect.arrayContaining([
        expect.objectContaining({
          name: "rigd-daemon",
          ok: true,
          details: expect.objectContaining({
            reachable: true,
          }),
        }),
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
    expect(daemonAdmin.statusRequests).toEqual([{ stateRoot: expect.stringContaining(".rig") }])
    expect(logger.infos.at(-1)?.message).toBe("rig doctor report")
  })

  test("GIVEN doctor outside a managed repo WHEN running THEN it emits Host diagnostics without requiring a Project", async () => {
    const { exitCode, logger, doctor, configLoader } = await runWithLogger([
      "doctor",
    ])

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(configLoader.loads).toEqual([])
    expect(doctor.reports[0]).toMatchObject({
      project: "host",
      providers: expect.arrayContaining([
        expect.objectContaining({
          name: "rigd-daemon",
          ok: true,
        }),
        expect.objectContaining({
          name: "host-capability",
          ok: true,
        }),
      ]),
    })
    expect(logger.infos.at(-1)?.message).toBe("rig doctor report")
  })

  test("GIVEN doctor in a repo with invalid project config WHEN running THEN it reports a Project diagnostic", async () => {
    const { exitCode, logger, doctor } = await runWithLogger([
      "doctor",
    ], {
      inferredProject: "pantry",
      configLoadFails: true,
    })

    expect(exitCode).toBe(0)
    expect(logger.errors).toEqual([])
    expect(doctor.reports[0]).toMatchObject({
      project: "pantry",
      providers: expect.arrayContaining([
        expect.objectContaining({
          name: "project-config",
          ok: false,
          reason: "project-config-invalid",
        }),
      ]),
    })
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

  test("GIVEN config set WHEN running THEN normal CLI rejects generic config writes", async () => {
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

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("RigCliArgumentError")
    expect(rigd.configPreviewRequests).toEqual([])
    expect(rigd.configApplyRequests).toEqual([])
  })

  test("GIVEN config unset WHEN running THEN normal CLI rejects generic config writes", async () => {
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

    expect(exitCode).toBe(1)
    expect(logger.errors[0]?._tag).toBe("RigCliArgumentError")
    expect(rigd.configApplyRequests).toEqual([])
  })

  test("GIVEN up without Target inside managed repo WHEN non-interactive THEN it fails with Target guidance", async () => {
    const { exitCode, logger, lifecycle, configLoader } = await runWithLogger(["up"], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(1)
    expect(configLoader.loads).toEqual([])
    expect(lifecycle.requests).toEqual([])
    expect(logger.errors[0]).toEqual(expect.objectContaining({
      _tag: "RigCliArgumentError",
      message: "rig up requires a Target in non-interactive use.",
      hint: "Pass 'local', 'live', or 'preview <branch>'.",
    }))
  })

  test("GIVEN up local inside managed repo WHEN running THEN it loads config and targets local", async () => {
    const { exitCode, logger, lifecycle, configLoader } = await runWithLogger(["up", "local"], {
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
        target: { kind: "local" },
        stateRoot: expect.stringContaining(".rig"),
        config: expect.objectContaining({
          name: "pantry",
        }),
      },
    ])
  })

  test("GIVEN up preview branch inside managed repo WHEN running THEN lifecycle targets that Preview", async () => {
    const { exitCode, logger, lifecycle, configLoader } = await runWithLogger([
      "up",
      "preview",
      "feature/preview",
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
    expect(lifecycle.requests).toEqual([
      {
        action: "up",
        project: "pantry",
        target: { kind: "generated", deploymentName: "feature/preview" },
        stateRoot: expect.stringContaining(".rig"),
        config: expect.objectContaining({
          name: "pantry",
        }),
      },
    ])
  })

  test("GIVEN preview lifecycle without branch WHEN running THEN it fails with branch guidance", async () => {
    const { exitCode, logger, lifecycle, configLoader } = await runWithLogger([
      "up",
      "preview",
    ], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(1)
    expect(configLoader.loads).toEqual([])
    expect(lifecycle.requests).toEqual([])
    expect(logger.errors[0]).toEqual(expect.objectContaining({
      _tag: "RigCliArgumentError",
      message: "rig up preview requires a Branch.",
      hint: "Pass the Preview Branch, for example 'preview feature/login'.",
    }))
  })

  test("GIVEN bare branch lifecycle target WHEN running THEN it is rejected as an unknown Target", async () => {
    const { exitCode, logger, lifecycle, configLoader } = await runWithLogger([
      "up",
      "feature/preview",
    ], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(1)
    expect(configLoader.loads).toEqual([])
    expect(lifecycle.requests).toEqual([])
    expect(logger.errors[0]).toEqual(expect.objectContaining({
      _tag: "RigCliArgumentError",
      message: "Unknown Target 'feature/preview'.",
      hint: "Use 'local', 'live', or 'preview <branch>'.",
    }))
  })

  test("GIVEN restart live inside managed repo WHEN running THEN lifecycle receives restart with config", async () => {
    const { exitCode, logger, lifecycle, configLoader } = await runWithLogger([
      "restart",
      "live",
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
    expect(lifecycle.requests).toEqual([
      {
        action: "restart",
        project: "pantry",
        lane: "live",
        target: { kind: "live" },
        stateRoot: expect.stringContaining(".rig"),
        config: expect.objectContaining({
          name: "pantry",
        }),
      },
    ])
  })

  test("GIVEN explicit project inside matching repo WHEN config is omitted THEN repo config is still loaded", async () => {
    const { exitCode, logger, lifecycle, configLoader } = await runWithLogger([
      "up",
      "local",
      "--project",
      "pantry",
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
    expect(lifecycle.requests[0]).toMatchObject({
      action: "up",
      project: "pantry",
      config: expect.objectContaining({
        name: "pantry",
      }),
    })
  })

  test("GIVEN explicit project inside different repo WHEN config is omitted THEN runtime change is rejected", async () => {
    const { exitCode, logger, lifecycle, configLoader } = await runWithLogger([
      "up",
      "local",
      "--project",
      "api",
    ], {
      inferredProject: "pantry",
    })

    expect(exitCode).toBe(1)
    expect(configLoader.loads).toEqual([])
    expect(logger.errors).toEqual([
      expect.objectContaining({
        _tag: "RigCliArgumentError",
        message: "rig up requires a rig.json for runtime changes.",
      }),
    ])
    expect(lifecycle.requests).toEqual([])
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

  test("GIVEN logs with explicit project WHEN running THEN lifecycle request includes log options", async () => {
    const { exitCode, lifecycle } = await runWithLogger([
      "logs",
      "local",
      "--project",
      "pantry",
      "--lines",
      "25",
      "--follow",
    ])

    expect(exitCode).toBe(0)
    expect(lifecycle.requests[0]).toMatchObject({
      action: "logs",
      project: "pantry",
      lane: "local",
      lines: 25,
      follow: true,
    })
  })

  test("GIVEN repo-first command outside managed repo WHEN project is omitted THEN it logs a tagged argument error", async () => {
    const { exitCode, logger, lifecycle } = await runWithLogger(["up", "local"])

    expect(exitCode).toBe(1)
    expect(lifecycle.requests).toEqual([])
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]?._tag).toBe("RigCliArgumentError")
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
    expect(logger.errors[0]?._tag).toBe("RigCliArgumentError")
    expect(logger.errors[0]?.details?.originalTag).toBe("RigConfigValidationError")
  })
})
