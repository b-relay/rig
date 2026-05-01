import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import { decodeV2ProjectConfig } from "./config.js"
import {
  V2DeploymentManagerLive,
  V2DeploymentStore,
  type V2DeploymentRecord,
  type V2DeploymentStoreService,
} from "./deployments.js"
import { V2DeployIntents, V2DeployIntentsLive } from "./deploy-intent.js"
import { V2HomeConfigStore, type V2HomeConfig } from "./home-config.js"

class MemoryDeploymentStore implements V2DeploymentStoreService {
  readonly records = new Map<string, V2DeploymentRecord[]>()

  read(project: string, _stateRoot: string) {
    return Effect.succeed(this.records.get(project) ?? [])
  }

  write(project: string, _stateRoot: string, records: readonly V2DeploymentRecord[]) {
    this.records.set(project, [...records])
    return Effect.void
  }

  ensureState(_record: V2DeploymentRecord) {
    return Effect.void
  }

  removeState(_record: V2DeploymentRecord) {
    return Effect.void
  }
}

const projectConfig = () =>
  decodeV2ProjectConfig({
    name: "pantry",
    domain: "${subdomain}.preview.b-relay.com",
    components: {
      web: {
        mode: "managed",
        command: "bun run start -- --port ${web.port}",
        port: 3070,
      },
    },
    deployments: {
      subdomain: "${branchSlug}",
      providerProfile: "stub",
    },
  })

const defaultHomeConfig: V2HomeConfig = {
  deploy: {
    productionBranch: "main",
    generated: {
      maxActive: 5,
      replacePolicy: "oldest",
    },
  },
  providers: {
    defaultProfile: "default",
  },
  web: {
    controlPlane: "localhost",
  },
}

const runWithDeployIntents = async <A>(
  effect: Effect.Effect<A, unknown, V2DeployIntents>,
  options?: {
    readonly homeConfig?: V2HomeConfig
  },
) => {
  const store = new MemoryDeploymentStore()
  const deployments = Layer.provide(
    V2DeploymentManagerLive,
    Layer.succeed(V2DeploymentStore, store),
  )
  const layer = Layer.provide(
    V2DeployIntentsLive,
    Layer.mergeAll(
      deployments,
      Layer.succeed(V2HomeConfigStore, {
        read: () => Effect.succeed(options?.homeConfig ?? defaultHomeConfig),
        write: () => Effect.void,
      }),
    ),
  )
  const result = await Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { result, store }
}

describe("GIVEN v2 deploy intent model WHEN resolving pushes and CLI deploys THEN behavior is covered", () => {
  test("GIVEN git push to main ref WHEN resolving intent THEN live is targeted without semver", async () => {
    const config = await Effect.runPromise(projectConfig())
    const { result } = await runWithDeployIntents(
      Effect.gen(function* () {
        const intents = yield* V2DeployIntents
        return yield* intents.fromGitPush({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          ref: "main",
          mainRef: "main",
          config,
        })
      }),
    )

    expect(result).toMatchObject({
      source: "git-push",
      project: "pantry",
      ref: "main",
      target: "live",
      lane: "live",
    })
    expect(result.version).toBeUndefined()
    expect(result.rollbackAnchor).toBeUndefined()
    expect(result.generatedDeployment).toBeUndefined()
  })

  test("GIVEN git push to feature ref WHEN resolving intent THEN generated target is classified without materializing", async () => {
    const config = await Effect.runPromise(projectConfig())
    const { result, store } = await runWithDeployIntents(
      Effect.gen(function* () {
        const intents = yield* V2DeployIntents
        return yield* intents.fromGitPush({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          ref: "feature/preview",
          mainRef: "main",
          config,
        })
      }),
    )

    expect(result.target).toBe("generated")
    expect(result.deploymentName).toBe("feature-preview")
    expect(result).not.toHaveProperty("generatedDeployment")
    expect(store.records.get("pantry")).toBeUndefined()
  })

  test("GIVEN generated deploy intent cap reject policy WHEN cap is reached THEN intent still only classifies", async () => {
    const config = await Effect.runPromise(projectConfig())
    const { result, store } = await runWithDeployIntents(
      Effect.gen(function* () {
        const intents = yield* V2DeployIntents
        yield* intents.fromCliDeploy({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          ref: "feature/one",
          target: "generated",
          config,
        })
        return yield* intents.fromCliDeploy({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          ref: "feature/two",
          target: "generated",
          config,
        })
      }),
      {
        homeConfig: {
          ...defaultHomeConfig,
          deploy: {
            ...defaultHomeConfig.deploy,
            generated: {
              maxActive: 1,
              replacePolicy: "reject",
            },
          },
        },
      },
    )

    expect(result).toMatchObject({
      source: "cli",
      project: "pantry",
      ref: "feature/two",
      target: "generated",
      lane: "deployment",
      deploymentName: "feature-two",
    })
    expect(result).not.toHaveProperty("generatedDeployment")
    expect(store.records.get("pantry")).toBeUndefined()
  })

  test("GIVEN git push and no main ref WHEN home production branch matches THEN live is targeted", async () => {
    const { result } = await runWithDeployIntents(
      Effect.gen(function* () {
        const intents = yield* V2DeployIntents
        return yield* intents.fromGitPush({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          ref: "main",
        })
      }),
    )

    expect(result).toMatchObject({
      source: "git-push",
      ref: "main",
      target: "live",
      lane: "live",
    })
  })

  test("GIVEN project live deployBranch WHEN git push matches it THEN project config overrides home production branch", async () => {
    const config = await Effect.runPromise(decodeV2ProjectConfig({
      name: "pantry",
      components: {
        web: {
          mode: "managed",
          command: "bun run start -- --port ${web.port}",
          port: 3070,
        },
      },
      live: {
        deployBranch: "stable",
      },
    }))
    const { result } = await runWithDeployIntents(
      Effect.gen(function* () {
        const intents = yield* V2DeployIntents
        return yield* intents.fromGitPush({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          ref: "stable",
          config,
        })
      }),
    )

    expect(result).toMatchObject({
      ref: "stable",
      target: "live",
      lane: "live",
    })
  })

  test("GIVEN CLI deploy target WHEN resolving intent THEN refs and lanes do not require semver", async () => {
    const { result } = await runWithDeployIntents(
      Effect.gen(function* () {
        const intents = yield* V2DeployIntents
        return yield* intents.fromCliDeploy({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          ref: "HEAD",
          target: "live",
        })
      }),
    )

    expect(result).toMatchObject({
      source: "cli",
      project: "pantry",
      ref: "HEAD",
      target: "live",
      lane: "live",
    })
    expect(result.version).toBeUndefined()
  })

  test("GIVEN version bump metadata WHEN resolving THEN tags remain rollback anchors", async () => {
    const { result } = await runWithDeployIntents(
      Effect.gen(function* () {
        const intents = yield* V2DeployIntents
        const patch = yield* intents.bump({
          project: "pantry",
          currentVersion: "1.2.3",
          bump: "patch",
        })
        const explicit = yield* intents.bump({
          project: "pantry",
          currentVersion: "1.2.4",
          set: "2.0.0",
        })
        return { patch, explicit }
      }),
    )

    expect(result.patch).toMatchObject({
      project: "pantry",
      previousVersion: "1.2.3",
      nextVersion: "1.2.4",
      rollbackAnchor: "v1.2.3",
      tag: "v1.2.4",
    })
    expect(result.explicit.nextVersion).toBe("2.0.0")
    expect(result.explicit.rollbackAnchor).toBe("v1.2.4")
  })

  test("GIVEN dirty or stale release edge cases WHEN resolving THEN structured errors are returned", async () => {
    const { result } = await runWithDeployIntents(
      Effect.gen(function* () {
        const intents = yield* V2DeployIntents
        const dirty = yield* intents.fromCliDeploy({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          ref: "HEAD",
          target: "live",
          dirty: true,
        }).pipe(Effect.catch((error) => Effect.succeed(error)))
        const stale = yield* intents.fromGitPush({
          project: "pantry",
          stateRoot: "/tmp/rig-v2",
          ref: "main",
          mainRef: "main",
          staleRelease: true,
        }).pipe(Effect.catch((error) => Effect.succeed(error)))
        return { dirty, stale }
      }),
    )

    expect(result.dirty._tag).toBe("V2RuntimeError")
    expect(result.dirty.details?.reason).toBe("dirty")
    expect(result.stale._tag).toBe("V2RuntimeError")
    expect(result.stale.details?.reason).toBe("stale-release")
  })
})
